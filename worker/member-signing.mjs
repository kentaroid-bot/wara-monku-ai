import { Buffer } from "buffer";
import { Transaction } from "@solana/web3.js";
import { validateSenderSpend, withSenderLock, rememberSenderSignature } from "./sender-wallets.mjs";
import bs58 from "bs58";
import { stageNote, noteText } from "./payment-notes.mjs";
import { ed25519 } from "@noble/curves/ed25519";
import { toBase64 } from "../shared/auth-wire.mjs";
import { requireFreshBlockhash } from "./devnet-rpc.mjs";
import { paymentConnection } from "./payment-rpc.mjs";
import { feeKey } from "./relay.mjs";
import { ordinaryMessage, confirmedMessage, decodeTransaction } from "./member-transactions.mjs";
import { validSecret } from "./member-core.mjs";
import { Failure } from "./failure.mjs";

export async function memberSigning(op, core) {
  const { b, env, realm, query, hash, session, checkPin, encryptSeed, strong, bad, denied, fail } = core;
  if (op === "card-info" || op === "card-sign") {
    if (!validSecret(b.card)) denied();
    let m = await query(
      "SELECT * FROM members WHERE realm=? AND card_key=?",
      realm,
      await hash("card", b.card),
    ).first();
    if (!m || m.type === "phantom") denied();
    m = await core.backfill(m);
    if (op === "card-info") return { address: m.sender_address };
    await checkPin(m, b.pin);
    return signed(m,true);
  }
  if (op === "sign") {
    const { m } = await session();
    return signed(m,false);
  }
  async function signed(m, card) {
    let tx, ordinary, sender, address, last;
    try {
      last = Transaction.from(Buffer.from(b.tx,"base64")).instructions.at(-1);
      sender = last?.data[0] === 14;
      if (!sender && (card || m.type === "phantom")) denied();
      address = sender ? m.sender_address : m.address;
      tx = decodeTransaction(b.tx, address, feeKey(env)?.publicKey);
      if (card && (!b.checkout || !Number.isInteger(b.checkout.amount))) bad();
      ordinary = ordinaryMessage(
        tx.raw,
        address,
        card ? "card" : "session",
        card ? b.checkout : null,
        tx.sponsor,
      );
      if (!ordinary && !card && !confirmedMessage(tx.raw, address, tx.sponsor)) denied();
    } catch (e) {
      if (e instanceof Failure) throw e;
      bad();
    }
    if (card && !ordinary) denied();
    const finish = async () => {
      if (sender) await validateSenderSpend(core,m,last);
      await requireFreshBlockhash(paymentConnection(env), tx.blockhash, fail);
      if (!card && !ordinary) await strong(m, "payment");
      const seed = await encryptSeed(sender ? m.id + ":sender" : m.id, sender ? m.sender_sealed_seed : m.sealed_seed, true);
      if (sender) await rememberSenderSignature(core,m,tx.blockhash);
      const signature = ed25519.sign(tx.message, seed);
      if (card && b.note) await stageNote(core,bs58.encode(signature),b.checkout.store,noteText(b.note,bad));
      return { signature: toBase64(signature) };
    };
    return sender ? withSenderLock(core,m,finish) : finish();
  }
  bad();
}
