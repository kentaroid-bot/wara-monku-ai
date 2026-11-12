import { memoProgram, readPaymentMemo } from "../shared/payment-memo.mjs";
import { communityOpening, communityUpdate } from "../shared/community-metadata.mjs";
import { eligible, sponsoredInstructions } from "../shared/sponsorship.mjs";
import { Buffer } from "buffer";
import {
  Transaction,
  SystemInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  join,
  endMembership,
  spend,
  pk,
  createGroup,
  certify,
  offer,
  transfer,
} from "../shared/protocol.mjs";
import manifest from "../shared/deployment.mjs";
const program = pk(manifest.program);
const price = () =>
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 });
const limit = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 });

// Only accept the canonical complete message. For a sponsored message, relay
// also independently compares this declared top-up with live Devnet rent.
export function declaredRent(tx) {
  const funding = tx.instructions.find((ix) =>
    ix.programId.equals(SystemProgram.programId) && SystemInstruction.decodeInstructionType(ix) === "Transfer",
  );
  return funding
    ? Number(SystemInstruction.decodeTransfer(funding).lamports)
    : 0;
}

function matches(tx, address, instructions, sponsor) {
  const feePayer = sponsor || pk(address);
  const expected = new Transaction({
    feePayer,
    recentBlockhash: tx.recentBlockhash,
  });
  if (sponsor && !eligible(instructions, program)) return false;
  expected.add(
    ...(sponsor
      ? sponsoredInstructions(instructions, sponsor, declaredRent(tx))
      : instructions),
  );
  return expected.serializeMessage().equals(tx.serializeMessage());
}

// Rebuild the entire message, including fee policy and account metas. Never
// trust the command name or an instruction picked out of a client transaction.
export function ordinaryMessage(raw, address, scope, checkout, sponsor = null) {
  const tx = Transaction.from(raw);
  const last = tx.instructions.at(-1);
  if (
    !last?.programId.equals(program) ||
    !tx.feePayer?.equals(sponsor || pk(address))
  )
    return false;
  let instructions;
  if (last.data[0] === 14 && last.data.length === 25) {
    const preceding = tx.instructions.at(-2);
    let memo = "";
    if (preceding?.programId.equals(memoProgram)) {
      memo = readPaymentMemo(preceding.data);
      if (!memo || preceding.keys.length || (checkout && memo !== checkout.memo)) return false;
    } else if (checkout?.memo) return false;
    const n = last.data.readBigUInt64LE(1);
    const group = last.keys[1].pubkey,
      shop = last.keys[2].pubkey;
    if (
      n < 1n ||
      n > 10n ||
      (checkout &&
        (checkout.group !== String(group) ||
          checkout.store !== String(shop) ||
          checkout.amount !== Number(n)))
    )
      return false;
    instructions = [
      price(),
      ...spend(
        program,
        address,
        group,
        shop,
        n,
        last.data.readBigUInt64LE(9),
        last.data.readBigUInt64LE(17),
        memo,
      ),
    ];
  } else if (scope === "session" && last.data[0] === 12 && last.data[1] === 0) {
    instructions = [
      limit(),
      price(),
      join(
        program,
        address,
        last.keys[1].pubkey,
        address,
        false,
        last.keys[5]?.pubkey,
      ),
    ];
  } else return false;
  return matches(tx, address, instructions, sponsor);
}
export function decodeTransaction(encoded, address, configuredSponsor = null) {
  if (typeof encoded !== "string" || encoded.length > 1650) throw Error();
  const raw = Buffer.from(encoded, "base64"),
    tx = Transaction.from(raw);
  const sponsor =
    configuredSponsor && tx.feePayer?.equals(configuredSponsor)
      ? configuredSponsor
      : null;
  if (!tx.feePayer?.equals(sponsor || pk(address))) throw Error();
  return {
    raw,
    sponsor,
    message: tx.serializeMessage(),
    blockhash: tx.recentBlockhash,
  };
}
// A confirmation sheet authorizes WARA payments and the site's community
// administration. It cannot turn this endpoint into an arbitrary SOL signer.
export function confirmedMessage(raw, address, sponsor = null) {
  try {
    const tx = Transaction.from(raw),
      ix = tx.instructions,
      last = ix.at(-1);
    if (
      !last?.programId.equals(program) ||
      !tx.feePayer?.equals(sponsor || pk(address))
    )
      return false;
    const data = last.data,
      accounts = last.keys.map((k) => k.pubkey);
    let expected;
    if (sponsor && data[0] !== 15 && data[0] !== 16 && data[0] !== 17 && data[0] !== 18) return false;
    switch (data[0]) {
      case 18:
        if (data.length !== 2 || data[1] > 1 || (data[1] === 0 && String(accounts[2]) !== address)) return false;
        expected = [limit(), price(), endMembership(program,address,accounts[1],accounts[2],data[1] === 1)];
        break;
      case 17:
        if (data.length <= 67 || data.length > 467) return false;
        expected = [limit(), price(), communityUpdate(program, address, accounts[1],
          data[1], pk(data.subarray(2,34)), data[34], pk(data.subarray(35,67)), data.subarray(67))];
        break;
      case 16: {
        const opening = ix.at(-2);
        if (!opening?.programId.equals(program) || opening.data[0] !== 10 || opening.data.length > 434) return false;
        const creation = SystemInstruction.decodeCreateAccount(ix.at(-3));
        if (creation.lamports > 100_000_000) return false;
        expected = [limit(), price(), ...communityOpening(program, pk(address), opening.keys[1].pubkey,
          opening.data[1], pk(opening.data.subarray(2, 34)), opening.data.subarray(34), creation.lamports)];
        break;
      }
      case 10: {
        const creation = SystemInstruction.decodeCreateAccount(ix.at(-2));
        if (creation.lamports > 100_000_000 || data.length > 434) return false;
        expected = [
          limit(),
          price(),
          ...createGroup(
            program,
            address,
            accounts[1],
            data[1],
            pk(data.subarray(2, 34)),
            data.subarray(34),
            creation.lamports,
          ),
        ];
        break;
      }
      case 11:
        expected = [
          limit(),
          price(),
          certify(
            program,
            address,
            accounts[1],
            accounts[2],
            data.subarray(1).toString("utf8"),
          ),
        ];
        break;
      case 12:
        expected = [
          limit(),
          price(),
          join(program, address, accounts[1], accounts[2], true),
        ];
        break;
      case 13:
        expected = [
          limit(),
          price(),
          offer(program, address, accounts[1], accounts[2], data[1] === 1),
        ];
        break;
      case 15: {
        const lots = ix
          .filter((i) => i.programId.equals(program) && i.data[0] === 15)
          .map((i) => ({
            origin: i.keys[2].pubkey,
            amount: i.data.readBigUInt64LE(1),
          }));
        if (lots.some((l) => l.amount < 1n)) return false;
        expected = [
          price(),
          ...transfer(program, address, accounts[1], accounts[3], lots),
        ];
        break;
      }
      default:
        return false;
    }
    return matches(tx, address, expected, sponsor);
  } catch {
    return false;
  }
}
