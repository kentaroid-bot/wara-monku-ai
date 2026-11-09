// Actual network smoke test, isolated from Phantom and personal wallets.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SystemProgram} from '@solana/web3.js';
import {getMint,getAccount,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction} from '@solana/spl-token';
import {connection,payer,key,send,save} from './devnet-common.mjs';
import {pk,enrollInstruction,paymentInstructions,readPerson,readInstance,readClock,currentDay,remaining} from '../app/protocol.mjs';
const manifest=JSON.parse(await readFile('deployments/devnet.json','utf8'));if(!manifest.program||!manifest.instances.demo)throw Error('Deploy first: npm run deploy:devnet');
const program=pk(manifest.program),config=pk(manifest.instances.demo.config),instance=await readInstance(connection,program,config);
const funding=await payer(),id=Date.now();const alice=await key(`smoke-${id}-consumer`),bob=await key(`smoke-${id}-producer`),carol=await key(`smoke-${id}-supplier`);
const evidence={cluster:'devnet',program:String(program),config:String(config),mint:String(instance.mint),binarySha256:manifest.binarySha256,startedAt:new Date().toISOString(),consumer:String(alice.publicKey),producer:String(bob.publicKey),supplier:String(carol.publicKey),transactions:[],checks:[]};
async function record(label,ix,signers){const signature=await send(ix,signers);evidence.transactions.push({label,signature});console.log(`${label}: ${signature}`);await save('deployments/devnet-smoke.json',evidence);return signature;}
const person=()=>readPerson(connection,program,config,alice.publicKey),day=async()=>currentDay(await readClock(connection),instance),supply=async()=>(await getMint(connection,instance.mint)).supply;
await record('fund-test-wallets',[alice,bob].map(k=>SystemProgram.transfer({fromPubkey:funding.publicKey,toPubkey:k.publicKey,lamports:20_000_000})),[funding]);
const startSupply=await supply();await record('enroll-no-mint',[enrollInstruction(program,config,alice.publicKey)],[alice]);assert.equal(await supply(),startSupply);evidence.checks.push('enrollment does not mint');
// Start early in a 120s period, so ordinary RPC latency does not cross the first payment boundary.
while((await readClock(connection))%120n>70n){console.log('Waiting for the next 120-second demonstration period…');await new Promise(r=>setTimeout(r,10000));}
const firstDay=await day();const firstNonce=(await person()).nonce;await record('pay-300-consumer-only',paymentInstructions(program,config,alice.publicKey,bob.publicKey,300n,firstDay,firstNonce),[alice]);
assert.equal((await person()).spent,300n);assert.equal(await supply(),startSupply+300n);evidence.checks.push('consumer signature alone mints exactly 300');
let replayRejected=false;try{await send(paymentInstructions(program,config,alice.publicKey,bob.publicKey,300n,firstDay,firstNonce),[alice]);}catch(e){if(!String(e).includes('custom program error: 0x3'))throw e;replayRejected=true;}
assert(replayRejected);evidence.checks.push('fresh transaction with consumed nonce rejected');
let rejected=false;try{await send(paymentInstructions(program,config,alice.publicKey,bob.publicKey,1n,firstDay,(await person()).nonce),[alice]);}catch(e){if(!String(e).includes('custom program error: 0x2'))throw e;rejected=true;}
assert(rejected);assert.equal(await supply(),startSupply+300n);evidence.checks.push('301st unit rejected with limit error');
while(await day()===firstDay){console.log('Waiting for chain day change…');await new Promise(r=>setTimeout(r,10000));}
assert.equal(remaining(await person(),await day()),300n);assert.equal(await supply(),startSupply+300n);evidence.checks.push('new day refreshes rights without minting or expiring credit');
const src=getAssociatedTokenAddressSync(instance.mint,bob.publicKey),dst=getAssociatedTokenAddressSync(instance.mint,carol.publicKey);
await record('transfer-persistent-credit',[createAssociatedTokenAccountIdempotentInstruction(bob.publicKey,dst,carol.publicKey,instance.mint),createTransferCheckedInstruction(src,instance.mint,dst,bob.publicKey,50n,0)],[bob]);
assert.equal((await getAccount(connection,src)).amount,250n);assert.equal((await getAccount(connection,dst)).amount,50n);assert.equal(await supply(),startSupply+300n);evidence.checks.push('credit remains transferable after day change');
await record('next-day-pay-100',paymentInstructions(program,config,alice.publicKey,bob.publicKey,100n,await day(),(await person()).nonce),[alice]);
assert.equal((await person()).spent,100n);assert.equal(await supply(),startSupply+400n);evidence.checks.push('next day payment issues only 100');
for(const item of evidence.transactions.filter(x=>x.label.includes('pay-'))){
 const tx=await connection.getTransaction(item.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
 assert(tx,'Confirmed transaction must be readable');assert.equal(tx.transaction.message.header.numRequiredSignatures,1);assert.equal(tx.transaction.signatures.length,1);assert.equal(tx.meta.err,null);item.requiredSignatures=1;
}
evidence.checks.push('on-chain payment transactions each require exactly one signature');
evidence.completedAt=new Date().toISOString();evidence.result='passed';evidence.phantom='not exercised by this script';await save('deployments/devnet-smoke.json',evidence);console.log('Devnet daily cycle passed. Phantom UI requires its own wallet check.');
