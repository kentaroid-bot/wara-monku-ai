import { Buffer } from "buffer";
import { Keypair, Transaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { pk, addr, assertDevnet, sponsorJoin, closeSenderPda, closeSenderMember } from "../shared/protocol.mjs";
import manifest from "../shared/deployment.mjs";
import { paymentConnection } from "./payment-rpc.mjs";
import { feeKey } from "./relay.mjs";
import { Failure } from "./failure.mjs";

const program = pk(manifest.program);
export const rotationSeconds = 30 * 86400;
const temporary = core => core.fail(503,"Devnetで贈る用アドレスの状態を確認できません。少し待ってから再試行してください。");
async function checked(core, operation) {
  try {
    const rpc = paymentConnection(core.env);
    await assertDevnet(rpc);
    return await operation(rpc);
  } catch (error) {
    if (error instanceof Failure) throw error;
    temporary(core);
  }
}
function memberRow(account, group, user) {
  if (!account || !account.owner.equals(program) || account.data.length !== 66) return null;
  const d = Buffer.from(account.data);
  return d[0] === 33 && d.subarray(1,33).equals(pk(group).toBuffer()) &&
    d.subarray(33,65).equals(pk(user).toBuffer()) ? d[65] : null;
}
export async function senderUsage(core, address) {
  return checked(core, async rpc => {
    const [clock, person] = await rpc.getMultipleAccountsInfo([SYSVAR_CLOCK_PUBKEY,addr(program,"p3",address)],"confirmed");
    if (!clock || clock.data.length < 40) temporary(core);
    const timestamp = Buffer.from(clock.data).readBigInt64LE(32);
    if (timestamp < 0n) temporary(core);
    const day = Number((timestamp + 32400n) / 86400n);
    if (!person || (person.owner.equals(SystemProgram.programId) && !person.data.length)) return {day, spent:0, nonce:0n};
    const d = Buffer.from(person.data);
    if (!person.owner.equals(program) || d.length !== 25 || d[0] !== 35) temporary(core);
    const lastDay = Number(d.readBigInt64LE(1)), spent = Number(d.readBigUInt64LE(9));
    if (lastDay > day || spent > 10) temporary(core);
    return {day, spent:lastDay === day ? spent : 0, nonce:d.readBigUInt64LE(17)};
  });
}
export async function newSender(core, id) {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pair = Keypair.fromSeed(seed);
  return {address:String(pair.publicKey), sealed:await core.encryptSeed(id + ":sender",seed)};
}
export async function ensureSender(core, m) {
  if (m.sender_address) return m;
  // Read the old daily counter before assigning a separate identity. Failure must not reset the quota.
  const usage = await senderUsage(core,m.address);
  const next = await newSender(core,m.id);
  await core.query(`UPDATE members SET sender_address=?,sender_sealed_seed=?,sender_rotated_at=?,carried_day=?,carried_spent=?
    WHERE id=? AND realm=? AND sender_address IS NULL`,next.address,next.sealed,core.now,usage.day,usage.spent,m.id,core.realm).run();
  return core.byId(m.id);
}
export async function requireMainMembership(core, m, group) {
  return checked(core, async rpc => {
    const g = pk(group);
    const [account, member] = await rpc.getMultipleAccountsInfo([g,addr(program,"m3",g,m.address)],"confirmed");
    const d = account && Buffer.from(account.data);
    if (!account?.owner.equals(program) || d.length <= 66 || d[0] !== 31 || d[33] > 2)
      core.fail(403,"コミュニティを確認できません。");
    if (!d.subarray(1,33).equals(pk(m.address).toBuffer()) && memberRow(member,g,m.address) !== 2)
      core.fail(403,"主ウォレットでコミュニティに参加してください。");
  });
}
export async function validateSenderSpend(core, m, last) {
  const shop = String(last.keys[2].pubkey);
  if (String(last.keys[0].pubkey) !== m.sender_address || shop === m.address || shop === m.sender_address)
    core.fail(403,"自分の受け取り窓口には贈れません。");
  await requireMainMembership(core,m,last.keys[1].pubkey);
  const {day,spent,nonce} = await senderUsage(core,m.sender_address);
  const d = Buffer.from(last.data), n = d.readBigUInt64LE(1);
  const carried = m.carried_day === day ? m.carried_spent || 0 : 0;
  if (d.readBigInt64LE(9) !== BigInt(day) || d.readBigUInt64LE(17) !== nonce ||
      n < 1n || BigInt(carried + spent) + n > 10n)
    core.fail(409,"今日の残りiineが変わりました。画面を更新してください。");
}
async function authoritySend(core, instructions) {
  const signer = feeKey(core.env);
  if (!signer) core.fail(503,"手数料支援は設定されていません。");
  return checked(core, async rpc => {
    const latest = await rpc.getLatestBlockhash("confirmed");
    const tx = new Transaction({feePayer:signer.publicKey,...latest}).add(...instructions(signer.publicKey));
    tx.sign(signer);
    const signature = await rpc.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:"confirmed",maxRetries:3});
    // Poll only this signature: never regenerate an uncertain transaction here.
    for (let attempt=0; attempt<8; attempt++) {
      const {value:[status]} = await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true});
      if (status?.err) core.fail(422,"贈る用アカウントの更新が拒否されました。");
      if (["confirmed","finalized"].includes(status?.confirmationStatus)) return;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    temporary(core);
  });
}
export async function prepareSender(core,m,group) {
  await requireMainMembership(core,m,group);
  const status = await checked(core,async rpc=>memberRow(await rpc.getAccountInfo(addr(program,"m3",group,m.sender_address)),group,m.sender_address));
  if (status === 4) core.fail(403,"この贈る用アドレスは参加を停止されています。");
  if (status !== 2) await authoritySend(core,authority=>[sponsorJoin(program,authority,group,m.sender_address)]);
  return {prepared:true};
}
async function retiredTargets(core, sender) {
  return checked(core,async rpc=> {
    const rows = await rpc.getProgramAccounts(program,{filters:[{dataSize:66},{memcmp:{offset:33,bytes:sender}}]});
    const targets = [{kind:0,target_address:sender,group_id:null}];
    for (const {pubkey,account} of rows) {
      const d = Buffer.from(account.data);
      if (d[0] !== 33) continue;
      const group = String(pk(d.subarray(1,33)));
      if (!pubkey.equals(addr(program,"m3",group,sender)) || memberRow(account,group,sender) === null) temporary(core);
      targets.push({kind:1,target_address:sender,group_id:group});
    }
    return targets;
  });
}
export async function cleanupSenders(core, limit=12) {
  const {results} = await core.query("SELECT * FROM retired_sender_accounts WHERE realm=? ORDER BY created LIMIT ?",core.realm,limit).all();
  for (const row of results) {
    try {
      const target = row.kind === 0 ? addr(program,"p3",row.target_address) : addr(program,"m3",row.group_id,row.target_address);
      const account = await checked(core,rpc=>rpc.getAccountInfo(target,"confirmed"));
      if (account?.owner.equals(program)) await authoritySend(core,authority=>[
        row.kind === 0 ? closeSenderPda(program,authority,row.target_address,authority)
          : closeSenderMember(program,authority,row.group_id,row.target_address,authority),
      ]);
      else if (account && (!account.owner.equals(SystemProgram.programId) || account.data.length)) continue;
      await core.query("DELETE FROM retired_sender_accounts WHERE id=? AND realm=?",row.id,core.realm).run();
    } catch { /* Keep only unsuccessful recovery work; no member identifier or keys are retained. */ }
  }
}
export async function rotateSender(core,m) {
  await core.checkPin(m,core.b.pin);
  await core.limited("sender-rotate:"+m.id,5);
  const remaining = m.sender_rotated_at + rotationSeconds - core.now;
  if (remaining > 0) core.fail(409,`次の更新まであと${Math.ceil(remaining/86400)}日です。`);
  await requireExpiredSignatures(core,m);
  const usage = await senderUsage(core,m.sender_address);
  const targets = await retiredTargets(core,m.sender_address);
  const next = await newSender(core,m.id);
  const carried = (m.carried_day === usage.day ? m.carried_spent || 0 : 0) + usage.spent;
  // Compare-and-swap protects simultaneous rotations without invalidating the session revision.
  const leaseGuard = "EXISTS (SELECT 1 FROM wallet_tickets WHERE token=? AND detail=? AND expires>?)";
  const guard = "EXISTS (SELECT 1 FROM members WHERE id=? AND realm=? AND sender_address=? AND revision=?) AND " + leaseGuard;
  const args = [m.id,core.realm,m.sender_address,m.revision,
    core.senderLease.token,core.senderLease.lease,Math.floor(Date.now()/1000)];
  const statements = targets.map(row=>core.query(`INSERT INTO retired_sender_accounts
    SELECT ?,?,?,?,?,? WHERE ${guard}`,crypto.randomUUID(),core.realm,row.kind,row.target_address,row.group_id,core.now,...args));
  statements.push(core.query(`UPDATE members SET sender_address=?,sender_sealed_seed=?,sender_rotated_at=?,carried_day=?,carried_spent=?
    WHERE id=? AND realm=? AND sender_address=? AND revision=? AND ${leaseGuard}`,next.address,next.sealed,core.now,usage.day,carried,...args));
  const result = await core.db.batch(statements);
  if (!result.at(-1).meta.changes) core.fail(409,"アドレスが別の操作で更新されました。再読み込みしてください。");
  await cleanupSenders(core,Math.max(targets.length,12));
  return {profile:core.profile(await core.byId(m.id))};
}

// Serialize operations across Worker isolates using a short D1 lease. The lease
// owner is random, so a timed-out request cannot release a successor's lock.
export async function withSenderLock(core,m,operation) {
  const token = await core.hash("sender-lock",m.id), lease = crypto.randomUUID();
  const now = Math.floor(Date.now()/1000);
  const lock = await core.query(`INSERT INTO wallet_tickets VALUES(?,?,'sender-lock',?,?)
    ON CONFLICT(token) DO UPDATE SET detail=excluded.detail,expires=excluded.expires WHERE expires<=?
    RETURNING token`,token,core.realm,lease,now+120,now).first();
  if (!lock) core.fail(409,"贈る用アドレスを操作中です。少し待ってから再試行してください。");
  try {
    const current = await core.byId(m.id);
    if (!current || current.sender_address !== m.sender_address || current.revision !== m.revision)
      core.fail(409,"贈る用アドレスが更新されました。画面を更新してください。");
    core.senderLease = {token,lease};
    return await operation(current);
  } finally {
    delete core.senderLease;
    await core.query("DELETE FROM wallet_tickets WHERE token=? AND detail=?",token,lease).run();
  }
}
export async function rememberSenderSignature(core,m,blockhash) {
  // An already-issued signature remains usable even if the client has not relayed
  // it. Retain its blockhash until RPC proves expiry before closing any old PDA.
  const token = await core.hash("sender-signed",m.sender_address+":"+blockhash);
  const saved = await core.query(`INSERT INTO wallet_tickets
    SELECT ?,?,'sender-signed',?,? WHERE EXISTS
      (SELECT 1 FROM wallet_tickets WHERE token=? AND detail=? AND expires>?)
    ON CONFLICT(token) DO UPDATE SET detail=excluded.detail RETURNING token`,
    token,core.realm,JSON.stringify({sender:m.sender_address,blockhash}),Number.MAX_SAFE_INTEGER,
    core.senderLease.token,core.senderLease.lease,Math.floor(Date.now()/1000)).first();
  if (!saved) core.fail(409,"署名の準備に時間がかかりました。画面を更新して再試行してください。");
}
async function requireExpiredSignatures(core,m) {
  const {results} = await core.query(`SELECT token,detail FROM wallet_tickets
    WHERE realm=? AND purpose='sender-signed' AND json_extract(detail,'$.sender')=?`,core.realm,m.sender_address).all();
  for (const row of results) {
    const {blockhash} = JSON.parse(row.detail);
    const {value} = await checked(core,rpc=>rpc.isBlockhashValid(blockhash,{commitment:"confirmed"}));
    if (value) core.fail(409,"直前の贈る操作の有効期限を確認中です。数分待ってからアドレスを更新してください。");
    await core.query("DELETE FROM wallet_tickets WHERE token=? AND realm=?",row.token,core.realm).run();
  }
}
