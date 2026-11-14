import { Buffer } from "buffer";
import bs58 from "bs58";
import {
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import manifest from "../shared/deployment.mjs";
import { requireFreshBlockhash } from "./devnet-rpc.mjs";
import { eligible, rentShortfall } from "../shared/sponsorship.mjs";
import { pk } from "../shared/protocol.mjs";
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
    ([15,16,17,18].includes(last.data[0]))
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

const sendOptions = {skipPreflight:false, preflightCommitment:"confirmed", maxRetries:3};

export async function relayPayment({
  encoded,
  sponsor,
  member,
  receipts,
  reserveBudget,
  beforeMembershipEnd,
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
  if (previous) {
    tx.partialSign(sponsor);
    if (bs58.encode(tx.signature) !== previous)
      fail(409, "保存済みの取引署名と一致しません。");
    if (receipts.canReplay && !await receipts.canReplay(receipt, previous))
      fail(503, "前の送信結果を確認しています。");
    try {
      await rpc.sendRawTransaction(tx.serialize(), sendOptions);
    } catch {
      // A rejection on this replay says nothing about the earlier broadcast.
    }
    return {signature: previous};
  }
  await requireFreshBlockhash(rpc, tx.recentBlockhash, fail);
  if (declaredRent(tx) !== (await rentShortfall(rpc, last)))
    fail(409, "口座のRentが変わりました。画面を更新してください。");
  await reserveBudget();
  tx.partialSign(sponsor);
  const raw = tx.serialize(),
    signature = bs58.encode(tx.signature);
  // A Solana transaction ID is also the fee payer's usable signature.
  // Simulate the signed wire transaction before revealing or recording it.
  let simulation;
  try {
    simulation = await rpc.simulateTransaction(
      VersionedTransaction.deserialize(raw),
      {
        sigVerify: true,
        commitment: "confirmed",
      },
    );
  } catch (err) {
    fail(503, "Devnetの検証ノードと通信できませんでした。少し待ってから再試行してください。");
  }
  if (simulation.value.err)
    fail(422, "Devnetの事前検証で取引が拒否されました。");
  // Also invalidate direct relay clients, immediately before a verified broadcast.
  if (last.data[0] === 18) await beforeMembershipEnd(String(last.keys[1].pubkey),String(last.keys[2].pubkey));
  // Commit the ID before broadcasting. Even a dropped HTTP response can then
  // be reconciled by the user's signature without creating a second payment.
  if (!await receipts.insert(receipt, signature))
    fail(503, "前の送信結果を確認しています。");
  try {
    await rpc.sendRawTransaction(raw, sendOptions);
  } catch (error) {
    const message = error.transactionMessage ?? error.message ?? "";
    const processed = /already[ _-]*(?:been )?processed/i.test(message);
    const rejected = !processed && (error.logs || /simulation failed/i.test(message));
    if (!processed && (rejected || error.definitelyRejected === true)) {
      // An expired lease taken over by a replay may already have delivered.
      if (await receipts.remove?.(receipt) !== false) {
        if (rejected) fail(422, "Devnetの事前検証で取引が拒否されました。");
        fail(503, "Devnetの送信ノードが混雑しています。少し待ってからもう一度お試しください。");
      }
    }
    // A timeout or AlreadyProcessed must remain reconcilable by the same ID.
  }
  await receipts.complete?.(receipt, signature);
  return { signature };
}
