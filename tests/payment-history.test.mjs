import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,Transaction,TransactionMessage} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createTransferCheckedInstruction,createTransferInstruction} from '@solana/spl-token';
import {addresses,paymentInstructions} from '../app/protocol.mjs';
import {withReference} from '../app/receipt.mjs';
import {outgoingPayments,paymentSummary,paymentHistoryReader} from '../app/payment-history.mjs';
const k=()=>Keypair.generate().publicKey;
const midnight=Date.parse('2026-11-08T00:00:00+09:00')/1000;
function fixture({methods=['daily','credit'],versioned=false,recipient=null,self=false}={}){
 const sender=Keypair.generate(),payer=sender.publicKey,program=k(),config=k(),mint=addresses(program,config).mint;
 recipient??=self?payer:k();
 const source=getAssociatedTokenAddressSync(mint,payer),dest=getAssociatedTokenAddressSync(mint,recipient);
 const instructions=methods.map((method,i)=>withReference(method==='daily'?paymentInstructions(program,config,payer,recipient,100n,1n,BigInt(i)).at(-1):method==='credit'?createTransferCheckedInstruction(source,mint,dest,payer,50n,0):createTransferInstruction(source,dest,payer,25n),k()));
 const m=versioned?new TransactionMessage({payerKey:payer,recentBlockhash:String(k()),instructions}).compileToV0Message():new Transaction({feePayer:payer,recentBlockhash:String(k())}).add(...instructions).compileMessage();
 const keys=m.accountKeys??m.staticAccountKeys;
 const bal=(address,owner,value)=>({accountIndex:keys.findIndex(a=>a.equals(address)),mint:String(mint),owner:String(owner),uiTokenAmount:{amount:String(value),decimals:0}});
 return {context:{payer,program,config,mint},recipient,tx:{slot:10,blockTime:midnight,transaction:{message:m,signatures:['sig']},meta:{err:null,preTokenBalances:[bal(source,payer,300),bal(dest,recipient,0)],postTokenBalances:[bal(source,payer,250),bal(dest,recipient,150)],loadedAddresses:{writable:[],readonly:[]}}}};
}
test('buyer reads minted daily payments separately from existing WARA, including versioned messages',()=>{
 for(const versioned of [false,true]){
  const {tx,context}=fixture({versioned}),rows=outgoingPayments(tx,context);
  assert.deepEqual(rows.map(r=>[r.method,r.amount]),[['daily','100'],['credit','50']]);assert.notEqual(rows[0].id,rows[1].id);assert(rows.every(r=>r.reference));
  assert.deepEqual(paymentSummary({entries:rows,done:true,unknownTime:false},midnight),{total:150n,count:2,complete:true,daily:100n,credit:50n});
 }
});
test('buyer excludes failures, another payer, wrong config/mint, incoming payments, and self transfers',()=>{
 const f=fixture();f.tx.meta.err={};assert.deepEqual(outgoingPayments(f.tx,f.context),[]);f.tx.meta.err=null;
 assert.deepEqual(outgoingPayments(f.tx,{...f.context,payer:k()}),[]);
 assert.deepEqual(outgoingPayments(f.tx,{...f.context,config:k(),mint:k()}),[]);
 assert.deepEqual(outgoingPayments(f.tx,{...f.context,mint:k()}),[]);
 assert.deepEqual(outgoingPayments(f.tx,{...f.context,payer:f.recipient}),[]);
 const self=fixture({methods:['credit'],self:true});assert.deepEqual(outgoingPayments(self.tx,self.context),[]);
 const d=fixture({methods:['daily']});d.tx.transaction.message.header.numRequiredSignatures=0;assert.deepEqual(outgoingPayments(d.tx,d.context),[]);
});
test('ordinary transfer and transferChecked are WARA payments; malformed metadata is retriable',()=>{
 const f=fixture({methods:['credit','transfer']});assert.deepEqual(outgoingPayments(f.tx,f.context).map(r=>r.amount),['50','25']);
 f.tx.meta.preTokenBalances=[];f.tx.meta.postTokenBalances=[];assert.throws(()=>outgoingPayments(f.tx,f.context),/トークン情報/);
});
test('buyer totals use JST and bigint, excluding yesterday while labelling incomplete coverage',()=>{
 const entries=[{amount:'9007199254740993',method:'daily',blockTime:midnight},{amount:'7',method:'credit',blockTime:midnight},{amount:'999',method:'credit',blockTime:midnight-1}];
 const sum=paymentSummary({entries,done:true},midnight);assert.equal(sum.total,9007199254741000n);assert.equal(sum.daily,9007199254740993n);assert.equal(sum.credit,7n);
 assert.equal(paymentSummary({entries,done:false,oldest:midnight},midnight).complete,false);
 assert.equal(paymentSummary({entries:[...entries,{amount:'9',method:'daily',blockTime:null}],done:true},midnight).complete,false);
});
test('wallet reader preserves multiple payments in one transaction and deduplicates RPC signatures',async()=>{
 const f=fixture();let ready=false;const seen=[];
 const c={getSignaturesForAddress:async(a,o)=>{seen.push([String(a),o]);return [1,2].map(()=>({signature:'sig',blockTime:midnight,err:null,confirmationStatus:'confirmed'}));},getTransaction:async()=>ready?f.tx:null};
 const reader=paymentHistoryReader(c,f.context);await assert.rejects(reader.load());assert.equal(reader.snapshot().pages,0);
 ready=true;const state=await reader.load();assert.equal(state.entries.length,2);assert.equal(paymentSummary(state,midnight).total,150n);assert.equal(seen[0][0],String(f.context.payer));assert.equal(seen[1][1].before,undefined);
});
