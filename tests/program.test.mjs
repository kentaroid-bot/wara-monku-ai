import test from 'node:test';
import assert from 'node:assert/strict';
import {LiteSVM,FailedTransactionMetadata} from 'litesvm';
import {getTransactionDecoder} from '@solana/kit';
import {Keypair,Transaction,SystemProgram} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,createMintToCheckedInstruction} from '@solana/spl-token';
import {addresses,initInstructions,enrollInstruction,paymentInstructions,decodePerson,decodeConfig,currentDay,remaining} from '../app/protocol.mjs';

function fixture(period=86400){
 const svm=new LiteSVM(),program=Keypair.generate().publicKey,config=Keypair.generate(),alice=Keypair.generate(),bob=Keypair.generate(),carol=Keypair.generate();
 svm.addProgramFromFile(program.toBase58(),'target/deploy/straw_protocol.so');
 for(const k of [alice,bob,carol])svm.airdrop(k.publicKey.toBase58(),10_000_000_000n);
 const clock=svm.getClock();clock.unixTimestamp=1700000000n;svm.setClock(clock);
 const tx=(ix,signers=[alice])=>{svm.expireBlockhash();const t=new Transaction({feePayer:signers[0].publicKey,recentBlockhash:svm.latestBlockhash()}).add(...ix);t.sign(...signers);return t;};
 const send=(ix,signers)=>svm.sendTransaction(getTransactionDecoder().decode(tx(ix,signers).serialize()));
 const ok=r=>assert(!(r instanceof FailedTransactionMetadata),r.toString());
 const fail=r=>assert(r instanceof FailedTransactionMetadata,'Expected transaction rejection');
 const data=p=>Buffer.from(svm.getAccount(p.toBase58()).data);
 const {mint,authority,person}=addresses(program,config.publicKey,alice.publicKey);
 const state=()=>decodePerson(data(person));const supply=()=>data(mint).readBigUInt64LE(36);
 const balance=who=>data(getAssociatedTokenAddressSync(mint,who.publicKey)).readBigUInt64LE(64);
 const day=()=>currentDay(svm.getClock().unixTimestamp,decodeConfig(data(config.publicKey)));
 const pay=(n,nonce=state().nonce,d=day(),producer=bob)=>paymentInstructions(program,config.publicKey,alice.publicKey,producer.publicKey,n,d,nonce);
 ok(send(initInstructions(program,config.publicKey,alice.publicKey,period,Number(svm.minimumBalanceForRentExemption(81n))),[alice,config]));
 ok(send([enrollInstruction(program,config.publicKey,alice.publicKey)]));
 return {svm,program,config,alice,bob,carol,mint,authority,person,tx,send,ok,fail,data,state,supply,balance,day,pay};
}
test('300 cumulative limit; only accepted payments issue credit; replay and reenrollment fail',()=>{
 const f=fixture();const {send,ok,fail,pay,alice,bob,program,config,state,supply}=f;
 assert.equal(supply(),0n);ok(send(pay(100),[alice]));assert.equal(supply(),100n);assert.equal(state().spent,100n);
 fail(send(pay(100,0n),[alice]));fail(send(pay(201),[alice]));
 fail(send([enrollInstruction(program,config.publicKey,alice.publicKey)]));
 assert.equal(supply(),100n);assert.equal(state().nonce,1n);
 ok(send(pay(200),[alice]));fail(send(pay(1),[alice]));assert.equal(supply(),300n);
});
test('JST day boundary expires only capacity; credits survive, transfer, next payment mints',()=>{
 const f=fixture();const {svm,send,ok,fail,pay,alice,bob,carol,mint,state,day,supply,balance}=f;
 ok(send(pay(300),[alice]));const oldDay=day();const clock=svm.getClock();
 clock.unixTimestamp=(oldDay+1n)*86400n-32400n-1n;svm.setClock(clock);assert.equal(remaining(state(),day()),0n);
 clock.unixTimestamp++;svm.setClock(clock);assert.equal(remaining(state(),day()),300n);assert.equal(supply(),300n);
 fail(send(pay(1,state().nonce,oldDay),[alice]));
 const src=getAssociatedTokenAddressSync(mint,bob.publicKey),dst=getAssociatedTokenAddressSync(mint,carol.publicKey);
 ok(send([createAssociatedTokenAccountIdempotentInstruction(bob.publicKey,dst,carol.publicKey,mint),createTransferCheckedInstruction(src,mint,dst,bob.publicKey,50n,0)],[bob]));
 assert.equal(balance(bob),250n);assert.equal(balance(carol),50n);assert.equal(supply(),300n);
 ok(send(pay(50),[alice]));assert.equal(state().spent,50n);assert.equal(supply(),350n);
});
test('consumer signature, recipient ownership, positive integer amount, and mint authority are enforced',()=>{
 const f=fixture();const {send,fail,pay,alice,bob,carol,mint,authority,supply,state}=f;
 // Precreate the recipient account. A merchant cannot spend the consumer allowance.
 f.ok(send([pay(10)[2]],[alice]));
 const ix=pay(10)[3];ix.keys[0].isSigner=false;fail(send([ix],[bob]));
 fail(send(pay(0),[alice]));fail(send(pay(301),[alice]));fail(send(pay(10,state().nonce,f.day(),alice),[alice]));
 const mismatch=pay(10);mismatch[3].keys[1].pubkey=carol.publicKey;fail(send(mismatch,[alice]));
 const mintIx=createMintToCheckedInstruction(mint,getAssociatedTokenAddressSync(mint,bob.publicKey),authority,1000n,0);mintIx.keys[2].isSigner=false;
 fail(send([pay(1)[2],mintIx],[alice]));assert.equal(supply(),0n);assert.equal(state().spent,0n);
});
test('two conflicting payments, transaction atomicity and cross-instance state',()=>{
 const f=fixture();const {send,ok,fail,pay,alice,bob,state,supply,program,config}=f;
 const a=pay(200),b=pay(200);ok(send(a,[alice]));fail(send(b,[alice]));assert.equal(supply(),200n);
 // First instruction would succeed, but second exceeds cap: both must roll back.
 fail(send([...pay(50),...pay(100,state().nonce+1n).slice(2)],[alice]));assert.equal(state().spent,200n);assert.equal(supply(),200n);
 const other=Keypair.generate();ok(send(initInstructions(program,other.publicKey,alice.publicKey,120,Number(f.svm.minimumBalanceForRentExemption(81n))),[alice,other]));
 const malicious=pay(1);malicious[3].keys[2].pubkey=other.publicKey;fail(send(malicious,[alice]));assert.equal(supply(),200n);
});
test('120-second demonstration uses chain clock and resists rollback',()=>{
 const f=fixture(120);f.ok(f.send(f.pay(300),[f.alice]));const clock=f.svm.getClock();clock.unixTimestamp+=120n;f.svm.setClock(clock);
 f.ok(f.send(f.pay(10),[f.alice]));assert.equal(f.supply(),310n);clock.unixTimestamp-=120n;f.svm.setClock(clock);f.fail(f.send(f.pay(1),[f.alice]));
});
test('prefunded participant PDA cannot block enrollment or reset existing usage',()=>{
 const f=fixture(),wallet=Keypair.generate(),person=addresses(f.program,f.config.publicKey,wallet.publicKey).person;
 f.svm.airdrop(wallet.publicKey.toBase58(),1_000_000_000n);f.ok(f.send([SystemProgram.transfer({fromPubkey:f.alice.publicKey,toPubkey:person,lamports:Number(f.svm.minimumBalanceForRentExemption(0n))})]));
 f.ok(f.send([enrollInstruction(f.program,f.config.publicKey,wallet.publicKey)],[wallet]));assert.equal(decodePerson(f.data(person)).spent,0n);
});
test('consumer-only payment settles without recipient keys; exact replay and signature tampering fail',()=>{
 const f=fixture();const tx=f.tx(f.pay(100),[f.alice]);
 assert.equal(tx.signatures.length,1);assert(tx.signatures[0].publicKey.equals(f.alice.publicKey));
 const chainTx=getTransactionDecoder().decode(tx.serialize());f.ok(f.svm.sendTransaction(chainTx));
 assert.equal(f.balance(f.bob),100n);assert.equal(f.state().spent,100n);assert.equal(f.state().nonce,1n);
 f.fail(f.svm.sendTransaction(chainTx));assert.equal(f.supply(),100n);
 const tampered=f.tx(f.pay(20),[f.alice]);tampered.instructions[3].data.writeBigUInt64LE(21n,1);
 f.fail(f.svm.sendTransaction(getTransactionDecoder().decode(tampered.serialize({verifySignatures:false}))));
 assert.equal(f.state().spent,100n);assert.equal(f.supply(),100n);
});
test('recipient choice cannot bypass a consumed nonce or the wallet-wide daily cap',()=>{
 const f=fixture(),nonce=f.state().nonce;
 f.ok(f.send(f.pay(200,nonce,f.day(),f.bob),[f.alice]));
 f.fail(f.send(f.pay(50,nonce,f.day(),f.carol),[f.alice]));
 f.ok(f.send(f.pay(100,f.state().nonce,f.day(),f.carol),[f.alice]));
 f.fail(f.send(f.pay(1,f.state().nonce,f.day(),f.bob),[f.alice]));
 assert.equal(f.state().spent,300n);assert.equal(f.balance(f.bob),200n);assert.equal(f.balance(f.carol),100n);
});

test('readonly receipt reference preserves single-signature mint and transfer authorization',async()=>{
 const {withReference}=await import('../app/receipt.mjs');const f=fixture(),ref=Keypair.generate().publicKey;
 const pay=f.pay(300);pay[3]=withReference(pay[3],ref);const tx=f.tx(pay);assert.equal(tx.signatures.length,1);
 f.ok(f.svm.sendTransaction(getTransactionDecoder().decode(tx.serialize())));assert.equal(f.balance(f.bob),300n);
 const replay=f.pay(1,0n);replay[3]=withReference(replay[3],Keypair.generate().publicKey);f.fail(f.send(replay));
 const over=f.pay(1);over[3]=withReference(over[3],ref);f.fail(f.send(over));
 const src=getAssociatedTokenAddressSync(f.mint,f.bob.publicKey),dst=getAssociatedTokenAddressSync(f.mint,f.carol.publicKey);
 f.ok(f.send([createAssociatedTokenAccountIdempotentInstruction(f.bob.publicKey,dst,f.carol.publicKey,f.mint),withReference(createTransferCheckedInstruction(src,f.mint,dst,f.bob.publicKey,100n,0),ref)],[f.bob]));
 assert.equal(f.balance(f.carol),100n);assert.equal(f.balance(f.bob),200n);assert.equal(f.state().spent,300n);assert.equal(f.supply(),300n);
});
