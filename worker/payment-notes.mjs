import bs58 from "bs58";
import { Buffer } from "buffer";
import { Transaction } from "@solana/web3.js";
import { paymentMemo } from "../shared/payment-memo.mjs";
import { assertDevnet } from "../shared/protocol.mjs";
import { workerConnection } from "./devnet-rpc.mjs";
import { ordinaryMessage, confirmedMessage } from "./member-transactions.mjs";
import { feeKey } from "./relay.mjs";

export function noteText(value, bad) {
  try {
    const text = paymentMemo(value);
    if (text) return text;
  } catch {}
  bad();
}

// The payer's Ed25519 signature is identical before and after sponsorship.
export async function stageNote(core, payerSignature, shop, note) {
  await core.query(`INSERT INTO payment_notes (realm,payer_signature,shop,note) VALUES (?,?,?,?)
    ON CONFLICT(realm,payer_signature) DO NOTHING`,core.realm,payerSignature,shop,note).run();
  const row = await core.query("SELECT note,shop FROM payment_notes WHERE realm=? AND payer_signature=?",
    core.realm,payerSignature).first();
  if (row.note !== note || row.shop !== shop) core.fail(409,"この取引には別のひとことが登録されています。");
}

export async function prepareNote(core) {
  const member = core.b.access && !core.b.session ? {address:(await core.readTicket(core.b.access,"payment-notes",false)).address} : (await core.session()).m;
  let actorAddress;
  const note = noteText(core.b.note,core.bad);
  let receipt, shop;
  try {
    const raw = Buffer.from(core.b.tx,"base64");
    if (raw.length > 1232) throw Error();
    const tx = Transaction.from(raw), last = tx.instructions.at(-1);
    actorAddress = last.data[0] === 14 ? member.sender_address || member.address : member.address;
    const sponsor = tx.feePayer.toBase58() === actorAddress ? null : feeKey(core.env)?.publicKey;
    const actor = tx.signatures.find(s => s.publicKey.toBase58() === actorAddress);
    if (!actor?.signature || !tx.verifySignatures(false)) throw Error();
    const ina = last.data[0] === 14;
    if (!(ina ? ordinaryMessage(raw,actorAddress,"session",null,sponsor)
      : last.data[0] === 15 && confirmedMessage(raw,actorAddress,sponsor))) throw Error();
    shop = last.keys[ina ? 2 : 3].pubkey.toBase58();
    receipt = bs58.encode(actor.signature);
  } catch { core.bad(); }
  await core.limited("payment-note:"+actorAddress,30);
  await stageNote(core,receipt,shop,note);
  return {saved:true};
}

const signature = value => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) && bs58.decode(value).length === 64;

export async function readNotes(core) {
  const {b,query,realm} = core;
  const shop = b.access && !b.session ? (await core.readTicket(b.access,"payment-notes",false)).address : (await core.session()).m.address;
  if (!Array.isArray(b.receipts) || b.receipts.length > 20 || b.receipts.some(r=>!signature(r?.payerSignature)||!signature(r?.sig))) core.bad();
  if (!b.receipts.length) return {notes:[]};
  const receipts = new Map(b.receipts.map(r=>[r.payerSignature,r.sig]));
  const placeholders = Array.from(receipts,()=>"?").join(",");
  const {results} = await query(`SELECT n.*,r.signature AS relay_signature FROM payment_notes n
    LEFT JOIN relay_receipts r ON r.receipt=n.payer_signature
    WHERE n.realm=? AND n.shop=? AND n.payer_signature IN (${placeholders})`,realm,shop,...receipts.keys()).all();
  const notes = [], pending = [];
  for (const row of results) {
    const sig = receipts.get(row.payer_signature);
    if (row.confirmed_signature === sig) notes.push({sig,note:row.note});
    else if (!row.confirmed_signature && (row.payer_signature === sig || row.relay_signature?.split(":")[0] === sig))
      pending.push({sig,row});
  }
  if (pending.length) {
    const rpc = workerConnection(core.env);
    await assertDevnet(rpc);
    const {value} = await rpc.getSignatureStatuses(pending.map(p=>p.sig),{searchTransactionHistory:true});
    const updates = [];
    pending.forEach(({sig,row},i)=>{
      if (value[i]?.err || !["confirmed","finalized"].includes(value[i]?.confirmationStatus)) return;
      notes.push({sig,note:row.note});
      updates.push(query("UPDATE payment_notes SET confirmed_signature=? WHERE realm=? AND payer_signature=?",sig,realm,row.payer_signature));
    });
    if (updates.length) await core.db.batch(updates);
  }
  return {notes};
}
