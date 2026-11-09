import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,Transaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createTransferCheckedInstruction} from '@solana/spl-token';
import {paymentInstructions,addresses} from '../app/protocol.mjs';
import {withReference,matchReceipt,receiptLookup} from '../app/receipt.mjs';
import {createRequest,parseRequest} from '../app/qr-protocol.mjs';

const k=()=>Keypair.generate().publicKey;
function fixture(method='daily'){
 const payer=Keypair.generate(),recipient=k(),program=k(),config=k(),mint=addresses(program,config).mint;
 const context={program,config,mint},r=parseRequest(createRequest(context,recipient,100),context);
 const dest=getAssociatedTokenAddressSync(mint,recipient),src=getAssociatedTokenAddressSync(mint,payer.publicKey);
 const ix=method==='daily'?paymentInstructions(program,config,payer.publicKey,recipient,100n,1n,0n):[createTransferCheckedInstruction(src,mint,dest,payer.publicKey,100n,0)];
 ix[ix.length-1]=withReference(ix.at(-1),r.reference);
 const t=new Transaction({feePayer:payer.publicKey,recentBlockhash:String(k())}).add(...ix);t.sign(payer);
 const m=t.compileMessage(),index=m.accountKeys.findIndex(a=>a.equals(dest));
 const balance=amount=>({accountIndex:index,mint:String(mint),owner:String(recipient),uiTokenAmount:{amount,decimals:0}});
 const tx={slot:10,transaction:{message:m,signatures:['signature']},meta:{err:null,preTokenBalances:[balance('20')],postTokenBalances:[balance('120')]}};
 return {r,tx,balance,method};
}
test('daily and WARA receipts require reference, exact payment and recipient token increase',()=>{
 for(const method of ['daily','credit']){
  const {r,tx}=fixture(method);assert.equal(matchReceipt(tx,r,9)?.method,method);assert.equal(matchReceipt(tx,r)?.amount,'100');
  assert.equal(matchReceipt(tx,{...r,reference:String(k())}),null);
  assert.equal(matchReceipt(tx,{...r,amount:'99'}),null);
  assert.equal(matchReceipt(tx,{...r,recipient:String(k())}),null);
  assert.equal(matchReceipt(tx,{...r,mint:String(k())}),null);
  assert.equal(matchReceipt(tx,r,11),null);
  tx.meta.err={InstructionError:[0,'error']};assert.equal(matchReceipt(tx,r),null);
 }
});
test('no false receipt for unchanged balances, wrong owners/mint, reference-only transaction or duplicate reference',()=>{
 for(const mutate of [
  f=>f.tx.meta.postTokenBalances=[f.balance('20')],
  f=>f.tx.meta.postTokenBalances[0].owner=String(k()),
  f=>f.tx.meta.preTokenBalances[0].mint=String(k()),
  f=>f.tx.transaction.message.instructions.at(-1).data='1',
  f=>f.tx.transaction.message.instructions.push(f.tx.transaction.message.instructions.at(-1)),
  f=>f.tx.transaction.message.header.numRequiredSignatures=2,
  f=>f.tx.meta.postTokenBalances=[],
  f=>delete f.tx.meta.preTokenBalances,
 ]){const f=fixture();mutate(f);assert.equal(matchReceipt(f.tx,f.r),null);}
 const f=fixture();f.tx.meta.preTokenBalances=[];f.tx.meta.postTokenBalances=[f.balance('100')];assert(matchReceipt(f.tx,f.r));
});
test('lookup retries indexing delay, ignores failed/unconfirmed transactions, and propagates connection errors',async()=>{
 const {r,tx}=fixture();let reads=0,fail=false;
 const c={getSignaturesForAddress:async()=>{if(fail)throw Error('offline');return [
  {signature:'failed',slot:10,err:{},confirmationStatus:'confirmed'},
  {signature:'pending',slot:10,err:null,confirmationStatus:'processed'},
  {signature:'signature',slot:10,err:null,confirmationStatus:'confirmed'}];},getTransaction:async s=>{assert.equal(s,'signature');return ++reads===1?null:tx;}};
 const check=receiptLookup(c,r,9);assert.equal(await check(),null);assert.equal((await check()).signature,'signature');
 fail=true;await assert.rejects(check,/offline/);
});
test('lookup crosses irrelevant-reference pages and never accepts a mismatched RPC signature',async()=>{
 const {r,tx}=fixture();let pages=0;
 const c={getSignaturesForAddress:async(_key,options)=>{pages++;return options.before?[{signature:'signature',slot:10,err:null,confirmationStatus:'finalized'}]:Array.from({length:20},(_,i)=>({signature:`bad-${i}`,slot:11,err:{},confirmationStatus:'confirmed'}));},getTransaction:async()=>tx};
 assert.equal((await receiptLookup(c,r)()).signature,'signature');assert.equal(pages,2);
 tx.transaction.signatures=['different'];assert.equal(await receiptLookup(c,r)(),null);
});
test('v2 references are unique; legacy requests remain readable without automatic receipt',()=>{
 const {r}=fixture();const context={program:r.program,config:r.config,mint:r.mint};
 assert.notEqual(JSON.parse(createRequest(context,r.recipient,100)).reference,r.reference);
 assert.throws(()=>parseRequest(JSON.stringify({...r,reference:r.recipient}),context));
 assert.throws(()=>parseRequest(JSON.stringify({...r,reference:undefined}),context));
 const old=parseRequest(JSON.stringify({...r,schema:'wara-devnet/request/1',reference:undefined}),context);assert.equal(old.reference,undefined);
});
