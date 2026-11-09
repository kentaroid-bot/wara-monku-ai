import test from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, ComputeBudgetInstruction, Keypair, Transaction } from "@solana/web3.js";
import { DEVNET_GENESIS } from "../app/protocol.mjs";
import { join, spend } from "../mainstream/protocol.mjs";
import { program, rpc, submit } from "../mainstream/network.mjs";

function setup(t) {
  const payer = Keypair.generate();
  const profile = { address: String(payer.publicKey) };
  const group = Keypair.generate().publicKey;
  const storage = new Map();
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: k => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: k => storage.delete(k),
  } });
  t.after(() => old ? Object.defineProperty(globalThis, "localStorage", old) : delete globalThis.localStorage);
  t.mock.method(rpc, "getGenesisHash", async () => DEVNET_GENESIS);
  t.mock.method(rpc, "getBalance", async () => 10_000_000);
  t.mock.method(rpc, "getLatestBlockhash", async () => ({
    blockhash: String(Keypair.generate().publicKey), lastValidBlockHeight: 100,
  }));
  const broadcast = t.mock.method(rpc, "sendRawTransaction", async raw => {
    assert(Transaction.from(raw).verifySignatures());
  });
  t.mock.method(rpc, "getSignatureStatuses", async () => ({ value: [{ confirmationStatus: "confirmed" }] }));
  const send = (instructions, sign) => submit(profile, async () => ({
    publicKey: payer.publicKey, signTransaction: async tx => { sign(tx); tx.partialSign(payer); return tx; },
  }), instructions);
  return { payer: payer.publicKey, group, broadcast, send };
}

test("Phantom can sign an open-market join without altering the prepared message", async t => {
  const { payer, group, broadcast, send } = setup(t);
  await send([join(program, payer, group, payer)], tx => {
    if (!tx.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))) {
      // Emulate the provider's priority fee insertion for an unsigned, unbudgeted request.
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
    }
  });
  assert.equal(broadcast.mock.callCount(), 1);
});

test("payments preserve their larger compute budget and a changed destination never broadcasts", async t => {
  const { payer, group, broadcast, send } = setup(t);
  const shop = Keypair.generate().publicKey;
  await assert.rejects(send(spend(program, payer, group, shop, 1n, 1n, 0n), tx => {
    const fees = tx.instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId));
    assert.equal(fees.length, 2);
    const limit = fees.find(ix => ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitLimit");
    const price = fees.find(ix => ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitPrice");
    assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit).units, 350000);
    assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(price).microLamports, 0n);
    tx.instructions.at(-1).keys[2].pubkey = Keypair.generate().publicKey;
  }), /取引内容が変わり/);
  assert.equal(broadcast.mock.callCount(), 0);
});
