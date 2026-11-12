// The deployed program allocates these PDAs from an empty system account.
// Pre-funding the exact shortfall in the same transaction avoids a program upgrade.
import {
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { metadataAddress } from "./token-metadata.mjs";
import { addr, mintFor } from "./protocol.mjs";

export function eligible(ix, program) {
  const last = ix.at(-1);
  if (!last?.programId.equals(program)) return false;
  return (
    (last.data[0] === 16 && ix.at(-2)?.programId.equals(program) && ix.at(-2).data[0] === 10) ||
    last.data[0] === 17 || // transaction fee only; any extra group rent is paid by its owner
    last.data[0] === 14 ||
    last.data[0] === 15 ||
    (last.data[0] === 12 && last.data[1] === 0)
  );
}

export function rentTarget(last) {
  const [user, group] = last.keys;
  switch (last.data[0]) {
    case 16:
      // The deployed Metaplex CreateV1 allocates a 607-byte fungible metadata account.
      return { address: metadataAddress(mintFor(last.programId, group.pubkey)), size: 607 };
    case 12:
      return {
        address: addr(last.programId, "m3", group.pubkey, user.pubkey),
        size: 66,
      };
    case 14:
      return { address: addr(last.programId, "p3", user.pubkey), size: 25 };
    default:
      return null;
  }
}

export async function rentShortfall(connection, last) {
  const target = rentTarget(last);
  if (!target) return 0;
  const account = await connection.getAccountInfo(target.address, "confirmed");
  if (
    account?.owner.equals(last.programId) &&
    account.data.length === target.size
  )
    return 0;
  if (
    account &&
    (!account.owner.equals(SystemProgram.programId) || account.data.length)
  )
    throw Error("Rentの対象口座が不正です。");
  const minimum = await connection.getMinimumBalanceForRentExemption(
    target.size,
  );
  if (!Number.isSafeInteger(minimum) || minimum <= 0 || minimum > 5_000_000)
    throw Error("Rentが支援の上限を超えています。");
  // CreateV1 charges its creator the full rent even for a dusted metadata PDA.
  return last.data[0] === 16 ? minimum : Math.max(0, minimum - (account?.lamports ?? 0));
}

export function sponsoredInstructions(original, sponsor, rent) {
  // In particular the sponsor must never double as the user or an invitation signer.
  if (original.some((ix) => ix.keys.some((k) => k.pubkey.equals(sponsor))))
    throw Error("支援口座を利用者・参加者として指定できません。");
  const instructions = original.map((ix) => {
    if (!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return ix;
    return new TransactionInstruction({
      ...ix,
      keys: [{ ...ix.keys[0], pubkey: sponsor }, ...ix.keys.slice(1)],
    });
  });
  if (rent) {
    const target = rentTarget(original.at(-1));
    if (!target || !Number.isSafeInteger(rent) || rent < 1 || rent > 5_000_000)
      throw Error("不正なRent");
    const index = instructions.findIndex(
      (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
    );
    instructions.splice(
      index,
      0,
      SystemProgram.transfer({
        fromPubkey: sponsor,
        // CreateV1 debits the creator even when its PDA is pre-funded.
        // Only the canonical atomic opening may reimburse that signer.
        toPubkey: original.at(-1).data[0] === 16 ? original.at(-1).keys[0].pubkey : target.address,
        lamports: rent,
      }),
    );
  }
  return instructions;
}
