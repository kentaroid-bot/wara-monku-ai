import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {LiteSVM,FailedTransactionMetadata} from 'litesvm';
import {getTransactionDecoder} from '@solana/kit';
import {Keypair,Transaction,SystemProgram} from '@solana/web3.js';
import {addresses,initInstructions,enrollInstruction,paymentInstructions,decodePerson,decodeConfig,currentDay} from '../app/protocol.mjs';
import {METADATA_PROGRAM,metadataAddress,createMetadataInstruction,decodeMetadata} from '../scripts/token-metadata.mjs';

const metadataBinary=process.env.METADATA_PROGRAM_SO||'private/metaplex-token-metadata.so';
test('metadata CPI preserves credit and limits; creator, PDA and program checks reject substitution',
 {skip:!existsSync(metadataBinary)?'Dump the Devnet Metaplex binary as documented in TOKEN-METADATA.md':false},()=>{
 const svm=new LiteSVM(),program=Keypair.generate().publicKey,config=Keypair.generate(),creator=Keypair.generate(),receiver=Keypair.generate(),attacker=Keypair.generate();
 svm.addProgramFromFile(program.toBase58(),'target/deploy/straw_protocol.so');
 svm.addProgramFromFile(METADATA_PROGRAM.toBase58(),metadataBinary);
 for(const k of [creator,receiver,attacker])svm.airdrop(k.publicKey.toBase58(),10_000_000_000n);
 const send=(ix,signers=[creator])=>{svm.expireBlockhash();const t=new Transaction({feePayer:signers[0].publicKey,recentBlockhash:svm.latestBlockhash()}).add(...ix);t.sign(...signers);return svm.sendTransaction(getTransactionDecoder().decode(t.serialize()));};
 const ok=r=>assert(!(r instanceof FailedTransactionMetadata),r.toString()),fail=r=>assert(r instanceof FailedTransactionMetadata,'Expected rejection');
 const data=p=>Buffer.from(svm.getAccount(p.toBase58()).data);
 ok(send(initInstructions(program,config.publicKey,creator.publicKey,86400,Number(svm.minimumBalanceForRentExemption(81n))),[creator,config]));
 ok(send([enrollInstruction(program,config.publicKey,creator.publicKey)]));
 const {mint,person}=addresses(program,config.publicKey,creator.publicKey);
 const day=currentDay(svm.getClock().unixTimestamp,decodeConfig(data(config.publicKey)));
 const pay=(n,nonce)=>paymentInstructions(program,config.publicKey,creator.publicKey,receiver.publicKey,n,day,nonce);
 ok(send(pay(90,0n),[creator]));
 const mintBefore=data(mint),personBefore=data(person),configBefore=data(config.publicKey);
 const settings={name:'WARA Devnet',symbol:'WARA',uri:'https://example.org/wara.json'};
 const ix=()=>createMetadataInstruction(program,config.publicKey,creator.publicKey,settings);
 fail(send([createMetadataInstruction(program,config.publicKey,attacker.publicKey,settings)],[attacker]));
 const unsigned=ix();unsigned.keys[0].isSigner=false;fail(send([unsigned],[attacker]));
 for(const index of [2,3,4,5,7,8]){const altered=ix();altered.keys[index].pubkey=SystemProgram.programId;fail(send([altered]));}
 for(const bad of [{name:'x'.repeat(33)},{symbol:'x'.repeat(11)},{uri:'http://example.org/wara.json'},{name:'bad\0name'}]){
  fail(send([createMetadataInstruction(program,config.publicKey,creator.publicKey,{...settings,...bad})]));
 }
 const dust=metadataAddress(mint);ok(send([SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:dust,lamports:1_000_000})]));
 ok(send([ix()]));
 assert.deepEqual(data(mint),mintBefore);assert.deepEqual(data(person),personBefore);assert.deepEqual(data(config.publicKey),configBefore);
 const account=svm.getAccount(dust.toBase58());assert.equal(account.programAddress,METADATA_PROGRAM.toBase58());
 const m=decodeMetadata(data(dust));assert.equal(m.mint,mint.toBase58());assert.equal(m.updateAuthority,creator.publicKey.toBase58());
 assert.equal(m.name,settings.name);assert.equal(m.symbol,settings.symbol);assert.equal(m.uri,settings.uri);
 assert.equal(m.tokenStandard,2);assert.equal(m.sellerFeeBasisPoints,0);assert.equal(m.isMutable,1);
 fail(send([ix()])); // An existing metadata account cannot be replaced through this instruction.
 ok(send(pay(210,1n),[creator]));fail(send(pay(1,2n),[creator]));
 assert.equal(decodePerson(data(person)).spent,300n);assert.equal(data(mint).readBigUInt64LE(36),300n);
});

test('published token JSON keeps daily and demo identities distinct',()=>{
 const daily=JSON.parse(readFileSync('assets/wara-devnet.json')),demo=JSON.parse(readFileSync('assets/wara-devnet-demo.json'));
 assert.equal(daily.name,'WARA Devnet');assert.equal(demo.name,'WARA Devnet Demo');assert.notEqual(daily.symbol,demo.symbol);
 for(const m of [daily,demo]){assert(m.image.startsWith('https://raw.githubusercontent.com/kentaroid-bot/wara-monku-ai/'));assert.equal(m.properties.files[0].type,'image/png');}
});

test('community metadata belongs to its existing issuer and does not change the mint', {skip:!existsSync(metadataBinary)}, async () => {
 const {createGroup,metadata,mintFor}=await import('../mainstream/protocol.mjs');
 const {createCommunityMetadataInstruction}=await import('../scripts/token-metadata.mjs');
 const svm=new LiteSVM(), program=Keypair.generate().publicKey;
 svm.addProgramFromFile(String(program),'target/deploy/straw_protocol.so');
 svm.addProgramFromFile(String(METADATA_PROGRAM),metadataBinary);
 const owner=Keypair.generate(), other=Keypair.generate(), group=Keypair.generate(), second=Keypair.generate();
 const send=(ix, ...signers)=>{
   svm.expireBlockhash();
   const tx=new Transaction({feePayer:signers[0].publicKey,recentBlockhash:svm.latestBlockhash()}).add(...ix);
   tx.sign(...signers);
   return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
 };
 for(const [signer,g] of [[owner,group],[other,second]]){
   svm.airdrop(String(signer.publicKey),1000000000n);
   const data=metadata('川辺の市場','地域のテスト','地域');
   const result=send(createGroup(program,signer.publicKey,g.publicKey,0,signer.publicKey,data,Number(svm.minimumBalanceForRentExemption(66n+BigInt(data.length)))),signer,g);
   assert(!(result instanceof FailedTransactionMetadata),result.toString());
 }
 const mint=mintFor(program,group.publicKey), before=Buffer.from(svm.getAccount(String(mint)).data);
 const fields={name:'川辺の市場 WARA',symbol:'WARA',uri:'https://example.org/kawabe.json'};
 const ix=(signer,g)=>createCommunityMetadataInstruction(program,g.publicKey,signer.publicKey,fields);
 assert(send([ix(other,group)],other) instanceof FailedTransactionMetadata);
 const swapped=ix(other,group);swapped.keys[1].pubkey=second.publicKey;
 assert(send([swapped],other) instanceof FailedTransactionMetadata);
 const result=send([ix(owner,group)],owner);
 assert(!(result instanceof FailedTransactionMetadata),result.toString());
 const md=svm.getAccount(String(metadataAddress(mint)));
 assert.equal(md.programAddress,String(METADATA_PROGRAM));
 const decoded=decodeMetadata(md.data);
 assert.equal(decoded.mint,String(mint));assert.equal(decoded.name,fields.name);
 assert.equal(decoded.updateAuthority,String(owner.publicKey));assert.equal(decoded.tokenStandard,2);
 assert.deepEqual(Buffer.from(svm.getAccount(String(mint)).data),before);
 assert(send([ix(owner,group)],owner) instanceof FailedTransactionMetadata);
});
