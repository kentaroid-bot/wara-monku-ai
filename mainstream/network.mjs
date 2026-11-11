import { privateGroupView } from "./community-privacy.mjs";
export { codeKey } from "./community-privacy.mjs";
import { managedSession } from "./identity.mjs";
import { eligible, sponsoredInstructions, rentShortfall } from "../shared/sponsorship.mjs";
import { Buffer } from "buffer";
import {
  Connection,
  Transaction,
  Keypair,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import bs58 from "bs58";
import { assertDevnet, budgetInstructions } from "../app/protocol.mjs";
import { pk, addr, mintFor, tok, ata, parseRow, quota } from "./protocol.mjs";
import manifest from "../deployments/devnet.json" with { type: "json" };
export const program = pk(manifest.program);
export const rpc = new Connection(manifest.rpc, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});
const registryKey = "wara.v03.policy-directory." + program;
let verified;
async function ready() {
  return (verified ??= assertDevnet(rpc).catch((e) => {
    verified = null;
    throw e;
  }));
}
export async function loadState(address, force = false, requestedShop = null) {
  await ready();
  const who = pk(address);
  let cached;
  try {
    cached = JSON.parse(sessionStorage.getItem(registryKey));
  } catch {}
  let rows;
  if (!force && cached?.at > Date.now() - 45000 && Array.isArray(cached.rows) &&
      (!requestedShop || cached.rows.some(r => r.tag === 32 && r.group === requestedShop.group && r.to === requestedShop.store)))
    rows = cached.rows;
  else {
    const all = await rpc.getProgramAccounts(program);
    rows = all
      .map(({ pubkey, account }) => parseRow(account.data, pubkey.toBase58()))
      .filter(Boolean);
    try {
      sessionStorage.setItem(
        registryKey,
        JSON.stringify({ at: Date.now(), rows }),
      );
    } catch {}
  }
  const groups = rows.filter((r) => r.tag === 31),
    funds = new Map();
  const keys = [
      SYSVAR_CLOCK_PUBKEY,
      addr(program, "p3", who),
      ...groups.map((g) => ata(mintFor(program, g.id), who)),
    ],
    accounts = [];
  for (let i = 0; i < keys.length; i += 100)
    accounts.push(
      ...(await rpc.getMultipleAccountsInfo(
        keys.slice(i, i + 100),
        "confirmed",
      )),
    );
  const [clock, person] = accounts;
  if (!clock || clock.data.length < 40)
    throw Error("チェーン時刻を取得できません。");
  const day = (Buffer.from(clock.data).readBigInt64LE(32) + 32400n) / 86400n;
  const dust =
    person?.owner.equals(SystemProgram.programId) && person.data.length === 0;
  if (person && !dust && !person.owner.equals(program))
    throw Error("日次枠の所有者が不正です。");
  groups.forEach((g, i) => {
    const a = accounts[i + 2];
    if (a?.owner.equals(tok) && a.data.length === 165 && a.data[108] === 1)
      funds.set(g.id, Buffer.from(a.data).readBigUInt64LE(64));
  });
  const views = await Promise.all(groups.map(group => group.visibility === "private"
    ? privateGroupView(group, String(who), rows) : group));
  return {
    groups: views.filter(Boolean),
    rows,
    funds,
    day,
    ...quota(dust ? null : person?.data, day),
  };
}
export const linked = (rows, a, b) =>
  a === b ||
  [
    [a, b],
    [b, a],
  ].every(([x, y]) =>
    rows.some(
      (r) => r.tag === 34 && r.group === x && r.to === y && r.status === 1,
    ),
  );
async function feePayer() {
  const response = await fetch("/api/fee-payer", {cache:"no-store", redirect:"error"});
  if (response.status === 404) return null; // Previous Worker / static host.
  if (!response.ok) throw Error("手数料支援の状態を確認できません。");
  const {feePayerPubkey} = await response.json();
  return feePayerPubkey === null ? null : pk(feePayerPubkey);
}

async function relayRequest(path, payload) {
  const response = await fetch(path, {
    method:"POST", cache:"no-store", credentials:"same-origin", redirect:"error",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({...payload, session:managedSession()?.session}),
    signal:AbortSignal.timeout(18000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = Error(result.error || "手数料支援の送信に失敗しました。");
    error.rejected = response.headers.get("X-Wara-Auth") === "1" && response.status >= 400 && response.status < 500;
    throw error;
  }
  if (result.signature !== null && (typeof result.signature !== "string" || bs58.decode(result.signature).length !== 64))
    throw Error("取引署名を確認できません。");
  return result.signature;
}

const pendingKey = (a) => "wara.v3.pending." + a;
export const pendingSig = (a) => localStorage.getItem(pendingKey(a));
export async function checkPending(a) {
  const raw = pendingSig(a);
  if (!raw) return;
  const pending = JSON.parse(raw);
  const {height} = pending;
  let sig = pending.sig;
  if (!sig && pending.receipt) {
    sig = await relayRequest("/api/relay/status", {receipt:pending.receipt});
    if (!sig && (await rpc.getBlockHeight("finalized")) > height) {
      // Read again after observing expiry, in case the relay registered it
      // between the first lookup and the finalized block-height read.
      sig = await relayRequest("/api/relay/status", {receipt:pending.receipt});
      if (!sig) {
        localStorage.removeItem(pendingKey(a));
        throw Error("支援取引は受付されず、署名の期限が切れました。");
      }
    }
    if (!sig) throw Error("支援取引の受付を確認中です。更新で確認してください。");
    localStorage.setItem(pendingKey(a), JSON.stringify({sig,height}));
  }
  const [s] = (
    await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true })
  ).value;
  if (s?.err) {
    localStorage.removeItem(pendingKey(a));
    throw Error("取引はチェーンに拒否されました。");
  }
  if (["confirmed", "finalized"].includes(s?.confirmationStatus)) {
    localStorage.removeItem(pendingKey(a));
    return sig;
  }
  if (!s && (await rpc.getBlockHeight("finalized")) > height) {
    localStorage.removeItem(pendingKey(a));
    throw Error("署名の期限が切れました。履歴を確認してからお試しください。");
  }
  throw Error("着地確認中：" + sig + "。再送せず「更新」で確認してください。");
}
export async function submit(profile, wallet, ix, extra = []) {
  await assertDevnet(rpc);
  if (pendingSig(profile.address)) {
    const settled = await checkPending(profile.address);
    throw Error("前の取引が確定しました。画面を更新してください：" + settled);
  }
  const signer = await wallet();
  if (String(signer.publicKey) !== profile.address)
    throw Error("署名ウォレットが切り替わりました。");
  const sponsor = profile.managed && eligible(ix, program) ? await feePayer() : null;
  const opening = ix.at(-1)?.data[0] === 16;
  if ((!sponsor || opening) && (await rpc.getBalance(pk(profile.address))) === 0)
    throw Error(opening ? "開設用のDevnet SOLが必要です。アカウント画面の無料配布から受け取ってください。" :
      "登録は済んでいます。アカウント画面の無料Devnet SOLで取引手数料を準備してください。",
    );
  const rent = sponsor ? await rentShortfall(rpc, ix.at(-1)) : 0;
  // Use a rooted block shared by the browser and Worker RPC nodes.
  const latest = await rpc.getLatestBlockhash(profile.managed ? "finalized" : "confirmed"),
    tx = new Transaction({
      feePayer: sponsor || pk(profile.address),
      recentBlockhash: latest.blockhash,
    });
  // Set the fee policy before any wallet or invite signature. Payments already
  // supply their own, larger CU limit; Solana permits each budget type once.
  const missingBudget = budgetInstructions().filter(
    fee => !ix.some(i => i.programId.equals(fee.programId) && i.data[0] === fee.data[0]),
  );
  const original = [...missingBudget, ...ix];
  tx.add(...(sponsor
    ? sponsoredInstructions(original, sponsor, rent)
    : original));
  if (opening) {
    try { tx.serialize({ requireAllSignatures:false, verifySignatures:false }); }
    catch (error) {
      if (/too large|overrun/i.test(error.message)) throw Error("名称・説明を短くしてから開設してください。");
      throw error;
    }
  }
  if (extra.length) tx.partialSign(...extra);
  const before = tx.serializeMessage();
  const signed = await signer.signTransaction(tx);
  if (!Buffer.from(before).equals(signed.serializeMessage()))
    throw Error("署名時に取引内容が変わりました。送信を中止しました。");
  if (!signed.verifySignatures(!sponsor) || signed.signatures.some(s => !s.signature && !(sponsor && s.publicKey.equals(sponsor))))
    throw Error("必要な署名を確認できません。送信を中止しました。");
  if (pendingSig(profile.address)) throw Error("別の取引の送信結果を確認中です。更新してください。");
  const height = latest.lastValidBlockHeight;
  let sig;
  if (sponsor) {
    const userSignature = signed.signatures.find(s => String(s.publicKey) === profile.address).signature;
    const receipt = bs58.encode(userSignature);
    const encoded = signed.serialize({requireAllSignatures:false}).toString("base64");
    localStorage.setItem(pendingKey(profile.address), JSON.stringify({receipt,height}));
    try {
      sig = await relayRequest("/api/relay", {tx:encoded});
      if (!sig) throw Error();
    } catch (error) {
      if (error.rejected) {
        localStorage.removeItem(pendingKey(profile.address));
        throw error;
      }
      throw Error("支援取引の送信結果を確認中です。再送せず更新してください。");
    }
    localStorage.setItem(pendingKey(profile.address), JSON.stringify({sig,height}));
  } else {
    const raw = signed.serialize();
    sig = bs58.encode(signed.signature);
    localStorage.setItem(
      pendingKey(profile.address),
      JSON.stringify({ sig, height: latest.lastValidBlockHeight }),
    );
    try {
      await rpc.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
    } catch (e) {
      // Explicit preflight rejection means no submission. Ambiguous delivery stays pending.
      if (e.transactionMessage?.includes("simulation failed") || e.logs) {
        localStorage.removeItem(pendingKey(profile.address));
        throw Error(
          "Devnetが拒否しました。残高・参加状態・手数料を確認してください。",
        );
      }
      throw Error("送信結果を確認中：" + sig);
    }
  }
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 900));
    try {
      return await checkPending(profile.address);
    } catch (e) {
      if (!pendingSig(profile.address)) throw e;
    }
  }
  throw Error("着地確認中：" + sig + "。更新で確認してください。");
}
