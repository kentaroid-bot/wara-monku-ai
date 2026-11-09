import { Buffer } from "buffer";
import {
  Connection,
  Transaction,
  Keypair,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import bs58 from "bs58";
import { assertDevnet } from "../app/protocol.mjs";
import { pk, addr, mintFor, tok, ata, parseRow, quota } from "./protocol.mjs";
import manifest from "../deployments/devnet.json" with { type: "json" };
export const program = pk(manifest.program);
export const rpc = new Connection(manifest.rpc, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});
const registryKey = "wara.v03.directory." + program;
let verified;
async function ready() {
  return (verified ??= assertDevnet(rpc).catch((e) => {
    verified = null;
    throw e;
  }));
}
export async function loadState(address, force = false) {
  await ready();
  const who = pk(address);
  let cached;
  try {
    cached = JSON.parse(sessionStorage.getItem(registryKey));
  } catch {}
  let rows;
  if (!force && cached?.at > Date.now() - 45000 && Array.isArray(cached.rows))
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
  return {
    groups,
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
export const codeKey = (code) => {
  try {
    return Keypair.fromSeed(bs58.decode(code.trim()));
  } catch {
    throw Error("招待コードの形式が違います。");
  }
};
const pendingKey = (a) => "wara.v3.pending." + a;
export const pendingSig = (a) => localStorage.getItem(pendingKey(a));
export async function checkPending(a) {
  const raw = pendingSig(a);
  if (!raw) return;
  const { sig, height } = JSON.parse(raw);
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
  if ((await rpc.getBalance(pk(profile.address))) === 0)
    throw Error(
      "登録は済んでいます。アカウント画面の無料Devnet SOLで取引手数料を準備してください。",
    );
  const latest = await rpc.getLatestBlockhash(),
    tx = new Transaction({
      feePayer: pk(profile.address),
      recentBlockhash: latest.blockhash,
    }).add(...ix);
  if (extra.length) tx.partialSign(...extra);
  const before = tx.serializeMessage();
  const signed = await signer.signTransaction(tx);
  if (
    !Buffer.from(before).equals(signed.serializeMessage()) ||
    !signed.verifySignatures()
  )
    throw Error("署名する取引が一致しません。");
  const raw = signed.serialize(),
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
