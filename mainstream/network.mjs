import { pendingKey, policyDirectoryKey } from "./storage-keys.mjs";
import { syncPrivateGroups } from "./community-privacy.mjs";
import { memberApi } from "./member-ui.mjs";
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
import { publicDevnetFallback } from "../shared/devnet.mjs";
export const program = pk(manifest.program);

async function browserFetchRpc(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
    if (res.ok) return res;
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      const alt = url === manifest.rpc ? publicDevnetFallback : manifest.rpc;
      return await fetch(alt, { ...init, signal: AbortSignal.timeout(8000) });
    }
    return res;
  } catch {
    const alt = url === manifest.rpc ? publicDevnetFallback : manifest.rpc;
    return await fetch(alt, { ...init, signal: AbortSignal.timeout(8000) });
  }
}

export const rpc = new Connection(manifest.rpc, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
  fetch: browserFetchRpc,
});
const registryKey = policyDirectoryKey(program);
let verified;
async function ready() {
  return (verified ??= assertDevnet(rpc).catch((e) => {
    verified = null;
    throw e;
  }));
}
export async function loadState(address, force = false, requestedShop = null, directoryOnly = false) {
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
  const session = managedSession();
  const sync = () => syncPrivateGroups(groups, String(who), rows,
    session?.profile.address === String(who) ? memberApi : null, force);
  if (directoryOnly) return {rows,...await sync()};
  const syncPromise = sync();
  const keys = [
      SYSVAR_CLOCK_PUBKEY,
      addr(program, "p3", who),
      ...groups.map((g) => ata(mintFor(program, g.id), who)),
    ];
  const [views, accounts] = await Promise.all([syncPromise, (async () => {
    const accounts = [];
    for (let i = 0; i < keys.length; i += 100)
      accounts.push(...await rpc.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"));
    return accounts;
  })()]);
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
  return {
    ...views,
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
    signal:AbortSignal.timeout(path === "/api/relay" ? 35000 : 8000),
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

export const pendingSig = (a) => localStorage.getItem(pendingKey(a));
export const settlementEvents = new EventTarget();
function paymentEffect(instructions, viewer) {
  let amount = 0n, currency, incoming;
  for (const ix of instructions) {
    if (!ix.programId.equals(program) || ![14,15].includes(ix.data[0])) continue;
    const ina = ix.data[0] === 14;
    incoming = String(ix.keys[ina ? 2 : 3].pubkey) === viewer;
    if (!incoming && String(ix.keys[0].pubkey) !== viewer) return null;
    currency = ina ? "ina" : "wara";
    amount += Buffer.from(ix.data).readBigUInt64LE(1);
  }
  return amount ? {amount:String(amount),currency,incoming} : null;
}
function isCurrent(address, entry) {
  const current = JSON.parse(pendingSig(address));
  return current && ((entry.receipt && current.receipt === entry.receipt) || (entry.sig && current.sig === entry.sig));
}
export async function checkPending(a, pending = JSON.parse(pendingSig(a))) {
  if (!pending) return;
  const clear = () => {
    if (!isCurrent(a,pending)) return false;
    localStorage.removeItem(pendingKey(a));
    return true;
  };
  const {height} = pending;
  let sig = pending.sig;
  if (!sig && pending.receipt) {
    sig = await relayRequest("/api/relay/status", {receipt:pending.receipt});
    if (!sig && (await rpc.getBlockHeight("finalized")) > height) {
      sig = await relayRequest("/api/relay/status", {receipt:pending.receipt});
      if (!sig) {
        clear();
        throw Error("支援取引は受付されず、署名の期限が切れました。");
      }
    }
    if (!sig) throw Error("支援取引の受付を確認中です。");
    if (isCurrent(a,pending)) localStorage.setItem(pendingKey(a), JSON.stringify({...pending,sig}));
    pending.sig = sig;
  }
  const [s] = (await rpc.getSignatureStatuses([sig], { searchTransactionHistory:true })).value;
  if (s?.err) {
    clear();
    throw Error("取引はチェーンに拒否されました。");
  }
  if (["confirmed","finalized"].includes(s?.confirmationStatus)) {
    if (clear()) settlementEvents.dispatchEvent(new CustomEvent("confirmed",{
      detail:{address:a,sig,payment:pending.payment},
    }));
    return sig;
  }
  if (!s && (await rpc.getBlockHeight("finalized")) > height) {
    clear();
    throw Error("署名の期限が切れました。履歴を確認してからお試しください。");
  }
  throw Error("取引の確定を確認中です。");
}
export async function submit(profile, wallet, ix, extra = [], viewer = profile.address) {
  await assertDevnet(rpc);
  for (const address of new Set([viewer,profile.address])) {
    if (pendingSig(address)) {
      const settled = await checkPending(address);
      throw Error("前の取引が確定しました。画面を更新してください：" + settled);
    }
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
  if (pendingSig(viewer) || pendingSig(profile.address)) throw Error("別の取引の送信結果を確認中です。");
  const entry = {height:latest.lastValidBlockHeight,payment:paymentEffect(ix,viewer)};
  if (sponsor) {
    const userSignature = signed.signatures.find(s => String(s.publicKey) === profile.address).signature;
    entry.receipt = bs58.encode(userSignature);
    const encoded = signed.serialize({requireAllSignatures:false}).toString("base64");
    localStorage.setItem(pendingKey(viewer), JSON.stringify(entry));
    try {
      const sig = await relayRequest("/api/relay", {tx:encoded});
      if (sig && isCurrent(viewer,entry)) {
        entry.sig = sig;
        localStorage.setItem(pendingKey(viewer), JSON.stringify(entry));
      }
    } catch (error) {
      if (error.rejected) {
        if (isCurrent(viewer,entry)) localStorage.removeItem(pendingKey(viewer));
        throw error;
      }
      // The POST may already have landed. Only query its existing receipt.
    }
  } else {
    const raw = signed.serialize();
    entry.sig = bs58.encode(signed.signature);
    localStorage.setItem(pendingKey(viewer), JSON.stringify(entry));
    try { await rpc.sendRawTransaction(raw, {skipPreflight:false,maxRetries:3}); }
    catch (e) {
      if (e.transactionMessage?.includes("simulation failed") || e.logs) {
        if (isCurrent(viewer,entry)) localStorage.removeItem(pendingKey(viewer));
        throw Error("Devnetが拒否しました。残高・参加状態・手数料を確認してください。");
      }
    }
  }
  const deadline = Date.now()+15000;
  do {
    await new Promise(r=>setTimeout(r,entry.sig ? 900 : 1800));
    try { return await checkPending(viewer,entry); }
    catch (e) { if (!isCurrent(viewer,entry)) throw e; }
  } while (Date.now() < deadline);
  settlementEvents.dispatchEvent(new CustomEvent("waiting",{detail:{address:viewer}}));
  throw Error("支払いを再送せず、取引の確定を確認しています。");
}
