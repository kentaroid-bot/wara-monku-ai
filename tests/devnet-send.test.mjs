import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,SystemProgram,Transaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {connection,send} from '../scripts/devnet-common.mjs';
import {DEVNET_GENESIS} from '../app/protocol.mjs';
function mockRPC(t){
 const signer=Keypair.generate();let sent=null,count=0;
 t.mock.method(connection,'getGenesisHash',async()=>DEVNET_GENESIS);
 t.mock.method(connection,'getLatestBlockhash',async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}));
 t.mock.method(connection,'sendRawTransaction',async raw=>{sent=Transaction.from(raw);count++;return bs58.encode(sent.signature);});
 t.mock.method(connection,'onSignature',()=>{throw Error('Websocket must not be used');});
 return {signer,instructions:[SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})],sent:()=>sent,count:()=>count};
}
test('script confirmation uses HTTP and returns the same signed transaction',async t=>{
 const f=mockRPC(t);t.mock.method(connection,'getSignatureStatuses',async()=>({value:[{err:null,confirmationStatus:'finalized'}]}));
 const sig=await send(f.instructions,[f.signer]);assert.equal(sig,bs58.encode(f.sent().signature));assert.equal(f.count(),1);assert(f.sent().verifySignatures());
});
test('confirmation transport failure preserves signature and never creates a replacement payment',async t=>{
 const f=mockRPC(t);t.mock.method(connection,'getSignatureStatuses',async()=>{throw Error('503');});
 await assert.rejects(send(f.instructions,[f.signer]),e=>e.message.includes('503')&&e.message.includes(bs58.encode(f.sent().signature)));
 assert.equal(f.count(),1);
});
test('on-chain failure is rejected rather than recorded as a successful transaction',async t=>{
 const f=mockRPC(t);t.mock.method(connection,'getSignatureStatuses',async()=>({value:[{err:{InstructionError:[0,{Custom:2}]},confirmationStatus:'confirmed'}]}));
 await assert.rejects(send(f.instructions,[f.signer]),/Transaction failed/);assert.equal(f.count(),1);
});
