import { Buffer } from "buffer";
import bs58 from "bs58";
import {
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import manifest from "../deployments/devnet.json" with { type: "json" };
import { requireFreshBlockhash } from "./devnet-rpc.mjs";
import { eligible, rentShortfall } from "../shared/sponsorship.mjs";
import { pk } from "../mainstream/protocol.mjs";
import {
  ordinaryMessage,
  confirmedMessage,
  declaredRent,
} from "./member-transactions.mjs";

const program = pk(manifest.program);
export function feeKey(env) {
  if (!env.FEE_PAYER_SECRET) return null;
  return Keypair.fromSecretKey(bs58.decode(env.FEE_PAYER_SECRET));
}

function inspect(encoded, sponsor, member) {
  if (typeof encoded !== "string" || encoded.length > 1644) throw Error();
  const raw = Buffer.from(encoded, "base64");
  if (raw.length > 1232 || raw.toString("base64") !== encoded) throw Error();
  const tx = Transaction.from(raw);
  const last = tx.instructions.at(-1);
  if (!eligible(tx.instructions, program) || !tx.feePayer?.equals(sponsor))
    throw Error();
  const actor = String(last.keys[0].pubkey);
  // A signed paper-card purchase is relayed by the logged-in cashier.
  if (
    member !== actor &&
    !(last.data[0] === 14 && member === String(last.keys[2].pubkey))
  )
    throw Error();
  const valid =
    last.data[0] === 15
      ? confirmedMessage(raw, actor, sponsor)
      : ordinaryMessage(raw, actor, "session", null, sponsor);
  if (
    !valid ||
    tx.signature ||
    tx.signatures.slice(1).some((s) => !s.signature) ||
    !tx.verifySignatures(false)
  )
    throw Error();
  const receipt = bs58.encode(
    tx.signatures.find((s) => String(s.publicKey) === actor).signature,
  );
  return { tx, last, receipt };
}

export async function relayPayment({
  encoded,
  sponsor,
  member,
  receipts,
  reserveBudget,
  fail,
  rpc,
}) {
  let payment;
  try {
    payment = inspect(encoded, sponsor.publicKey, member);
  } catch {
    fail(400, "許可された取引内容または利用者の署名を確認できません。");
  }
  const { tx, last, receipt } = payment;
  const previous = await receipts.find(receipt);
  if (previous) return { signature: previous };
  await requireFreshBlockhash(rpc, tx.recentBlockhash, fail);
  if (declaredRent(tx) !== (await rentShortfall(rpc, last)))
    fail(409, "口座のRentが変わりました。画面を更新してください。");
  await reserveBudget();
  tx.partialSign(sponsor);
  const raw = tx.serialize(),
    signature = bs58.encode(tx.signature);
  // A Solana transaction ID is also the fee payer's usable signature.
  // Simulate the signed wire transaction before revealing or recording it.
  const simulation = await rpc.simulateTransaction(
    VersionedTransaction.deserialize(raw),
    {
      sigVerify: true,
      commitment: "confirmed",
    },
  );
  if (simulation.value.err)
    fail(422, "Devnetの事前検証で取引が拒否されました。");
  // Commit the ID before broadcasting. Even a dropped HTTP response can then
  // be reconciled by the user's signature without creating a second payment.
  if (await receipts.insert(receipt, signature)) {
    try {
      await rpc.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
    } catch (error) {
      if (error.logs || error.transactionMessage?.includes("simulation failed"))
        fail(422, "Devnetの事前検証で取引が拒否されました。");
      // Delivery is ambiguous. Return the deterministic ID for on-chain lookup.
    }
  }
  return { signature };
}
