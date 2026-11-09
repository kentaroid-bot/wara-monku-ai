import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,Transaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createTransferCheckedInstruction} from '@solana/spl-token';
import {addresses,paymentInstructions} from '../app/protocol.mjs';
import {withReference} from '../app/receipt.mjs';
import {incomingReceipt,historyReader,historySummary,jstDay} from '../app/receipt-history.mjs';
const k=()=>Keypair.generate().publicKey;
function fixture(method='daily',reference=true){
 const sender=Keypair.generate(),recipient=k(),program=k(),config=k(),mint=addresses(program,config).mint;
 const context={program,config,mint,recipient},dest=getAssociatedTokenAddressSync(mint,recipient);
 let ix=method==='daily'?paymentInstructions(program,config,sender.publicKey,recipient,100n,1n,0n).at(-1):createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint,sender.publicKey),mint,dest,sender.publicKey,100n,0);
 if(reference)ix=withReference(ix,k());
 const t=new Transaction({feePayer:sender.publicKey,recentBlockhash:String(k())}).add(ix);t.sign(sender);const m=t.compileMessage(),index=m.accountKeys.findIndex(a=>a.equals(dest));
 const bal=n=>({accountIndex:index,mint:String(mint),owner:String(recipient),uiTokenAmount:{amount:String(n),decimals:0}});
 const tx={slot:1,blockTime:1700000000,transaction:{message:m,signatures:['sig']},meta:{err:null,preTokenBalances:[bal(50)],postTokenBalances:[bal(150)]}};
 return {context,tx,bal};
}
test('history distinguishes daily, WARA and manual payments by actual chain data',()=>{
 for(const method of ['daily','credit'])for(const ref of [true,false]){const f=fixture(method,ref),r=incomingReceipt(f.tx,f.context);assert.equal(r.method,method);assert.equal(r.amount,'100');assert.equal(Boolean(r.reference),ref);assert(r.payer);}
 const f=fixture();f.tx.transaction.message.instructions=[];assert.equal(incomingReceipt(f.tx,f.context).method,'other');
});
test('history ignores failed/outgoing/zero transactions and rejects incomplete or wrong-token metadata',()=>{
 const f=fixture();f.tx.meta.err={};assert.equal(incomingReceipt(f.tx,f.context),null);f.tx.meta.err=null;
 for(const n of [0,50]){f.tx.meta.postTokenBalances=[f.bal(n)];assert.equal(incomingReceipt(f.tx,f.context),null);}
 f.tx.meta.postTokenBalances=[f.bal(150)];f.tx.meta.postTokenBalances[0].mint=String(k());assert.throws(()=>incomingReceipt(f.tx,f.context));
 delete f.tx.meta.preTokenBalances;assert.throws(()=>incomingReceipt(f.tx,f.context));
});
test('JST midnight, exact bigint totals, and missing-time/partial history are explicit',()=>{
 const midnight=Date.parse('2026-11-08T00:00:00+09:00')/1000;
 assert.equal(jstDay(midnight),jstDay(midnight-1)+1);
 const state={entries:[{blockTime:midnight-1,amount:'100'},{blockTime:midnight,amount:'9007199254740993'},{blockTime:midnight+1,amount:'7'}],done:false,oldest:midnight-1,unknownTime:false};
 assert.deepEqual(historySummary(state,midnight+2),{total:9007199254741000n,count:2,complete:true});
 assert.equal(historySummary({...state,oldest:midnight},midnight+2).complete,false);
 assert.equal(historySummary({...state,unknownTime:true,done:true},midnight+2).complete,false);
 assert.equal(historySummary({...state,entries:[...state.entries,{blockTime:null,amount:'999'}],done:true},midnight+2).complete,false);
});
test('pagination deduplicates signatures, retries absent transactions, and does not advance on failure',async()=>{
 const f=fixture();let ready=false,calls=0;const options=[];
 const c={getSignaturesForAddress:async(_a,o)=>{options.push(o);return [{signature:'sig',slot:1,blockTime:f.tx.blockTime,err:null,confirmationStatus:'confirmed'},{signature:'sig',slot:1,blockTime:f.tx.blockTime,err:null,confirmationStatus:'confirmed'}];},getTransaction:async()=>{calls++;return ready?f.tx:null;}};
 const cache=new Map(),reader=historyReader(c,f.context,cache);await assert.rejects(reader.load());assert.equal(reader.snapshot().pages,0);
 ready=true;await reader.load();assert.equal(reader.snapshot().entries.length,1);assert.equal(reader.snapshot().done,true);assert.equal(options[1].before,undefined);assert.equal(calls,2);
 await historyReader(c,f.context,cache).load();assert.equal(calls,2);
});
test('a new wallet/instance uses a separate reader; history does not mix recipients',async()=>{
 const a=fixture(),b=fixture();assert.throws(()=>incomingReceipt(a.tx,b.context));
 const c={getSignaturesForAddress:async()=>[],getTransaction:async()=>{throw Error('unused');}};
 const empty=await historyReader(c,b.context).load();assert.equal(empty.entries.length,0);assert.equal(historySummary(empty,1700000000).total,0n);
});
