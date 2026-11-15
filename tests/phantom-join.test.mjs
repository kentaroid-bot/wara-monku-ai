import test from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, ComputeBudgetInstruction, Keypair, Transaction } from "@solana/web3.js";
import { DEVNET_GENESIS } from "../app/protocol.mjs";
import { join, spend } from "../mainstream/protocol.mjs";
import { program, rpc, submit } from "../mainstream/network.mjs";
import { unlock, recheckPhantom, PhantomAccountMismatch } from "../mainstream/identity.mjs";

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
  return { payer: payer.publicKey, keypair: payer, group, broadcast, send };
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

test("Phantom payment stops on the wrong account; reconnect checks only, then a new payment signs once", async t => {
  const { payer, keypair, group, broadcast } = setup(t);
  const wrong = Keypair.generate().publicKey;
  let selected = wrong;
  const provider = {
    isPhantom: true, isConnected: true, publicKey: wrong,
    async connect() {
      if (!this.isConnected) this.publicKey = selected;
      this.isConnected = true;
      return { publicKey: this.publicKey };
    },
    async disconnect() { this.isConnected = false; this.publicKey = null; },
    signTransaction: t.mock.fn(async tx => {tx.partialSign(keypair); return tx;}),
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis,"phantom");
  Object.defineProperty(globalThis,"phantom",{configurable:true,value:{solana:provider}});
  t.after(() => saved ? Object.defineProperty(globalThis,"phantom",saved) : delete globalThis.phantom);
  const profile = {type:"phantom",address:String(payer)};
  const pay = () => submit(profile,() => unlock(profile,""),
    spend(program,payer,group,Keypair.generate().publicKey,1n,1n,0n));
  await assert.rejects(pay(), error => error instanceof PhantomAccountMismatch &&
    error.message.includes(String(payer).slice(-6)) && error.message.includes(String(wrong).slice(-6)));
  await assert.rejects(recheckPhantom(profile.address), PhantomAccountMismatch);
  selected = payer;
  await recheckPhantom(profile.address);
  assert.equal(provider.signTransaction.mock.callCount(),0);
  assert.equal(broadcast.mock.callCount(),0);
  await pay();
  assert.equal(provider.signTransaction.mock.callCount(),1);
  assert.equal(broadcast.mock.callCount(),1);
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
