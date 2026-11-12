import { ed25519 } from "@noble/curves/ed25519";
import { toBase64 } from "../shared/auth-wire.mjs";
import { requireFreshBlockhash, workerConnection } from "./devnet-rpc.mjs";
import { feeKey } from "./relay.mjs";
import { ordinaryMessage, confirmedMessage, decodeTransaction } from "./member-transactions.mjs";
import { validSecret } from "./member-core.mjs";
import { Failure } from "./failure.mjs";

export async function memberSigning(op, core) {
  const { b, env, realm, query, hash, session, checkPin, encryptSeed, strong, bad, denied, fail } = core;
  if (op === "card-info" || op === "card-sign") {
    if (!validSecret(b.card)) denied();
    const m = await query(
      "SELECT * FROM members WHERE realm=? AND card_key=?",
      realm,
      await hash("card", b.card),
    ).first();
    if (!m || m.type === "phantom") denied();
    if (op === "card-info") return { address: m.address };
    await checkPin(m, b.pin);
    return signed(m, true);
  }
  if (op === "sign") {
    const { m } = await session();
    if (m.type === "phantom") denied();
    return signed(m, false);
  }
  async function signed(m, card) {
    let tx, ordinary;
    try {
      tx = decodeTransaction(b.tx, m.address, feeKey(env)?.publicKey);
      if (card && (!b.checkout || !Number.isInteger(b.checkout.amount))) bad();
      ordinary = ordinaryMessage(
        tx.raw,
        m.address,
        card ? "card" : "session",
        card ? b.checkout : null,
        tx.sponsor,
      );
      if (!ordinary && !card && !confirmedMessage(tx.raw, m.address, tx.sponsor)) denied();
    } catch (e) {
      if (e instanceof Failure) throw e;
      bad();
    }
    if (card && !ordinary) denied();
    await requireFreshBlockhash(workerConnection(env), tx.blockhash, fail);
    if (!card && !ordinary) await strong(m, "payment");
    const seed = await encryptSeed(m.id, m.sealed_seed, true);
    return { signature: toBase64(ed25519.sign(tx.message, seed)) };
  }
  bad();
}
