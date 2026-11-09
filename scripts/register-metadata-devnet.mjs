// Adds metadata to the existing Devnet mints. Never creates a replacement mint.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ComputeBudgetProgram} from '@solana/web3.js';
import {getMint,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {connection,payer,send,save} from './devnet-common.mjs';
import {pk,readInstance,assertDevnet,addresses} from '../app/protocol.mjs';
import {METADATA_PROGRAM,metadataAddress,createMetadataInstruction,decodeMetadata} from './token-metadata.mjs';
const dry=process.argv.includes('--check');
const manifest=JSON.parse(await readFile('deployments/devnet.json','utf8'));
assert.equal(manifest.cluster,'devnet');await assertDevnet(connection);
const creator=await payer(),program=pk(manifest.program);
const root='https://raw.githubusercontent.com/kentaroid-bot/wara-monku-ai/main/assets/';
const evidence={cluster:'devnet',program:manifest.program,binarySha256:manifest.binarySha256,checkedAt:new Date().toISOString(),instances:{}};
let previous;try{previous=JSON.parse(await readFile('deployments/devnet-metadata.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
async function publicFile(url){const r=await fetch(url);if(!r.ok)throw Error(`Metadata hosting unavailable: ${r.status} ${url}`);return Buffer.from(await r.arrayBuffer());}
async function snapshot(mint){
 const mintAccount=await connection.getAccountInfo(mint);
 const holders=await connection.getProgramAccounts(TOKEN_PROGRAM_ID,{filters:[{dataSize:165},{memcmp:{offset:0,bytes:mint.toBase58()}}]});
 const persons=await connection.getProgramAccounts(program);
 const hash=rows=>createHash('sha256').update(JSON.stringify(rows.map(x=>[String(x.pubkey),x.account.data.toString('base64')]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
 return {mintData:mintAccount.data.toString('base64'),holderCount:holders.length,holdersHash:hash(holders),protocolStateHash:hash(persons)};
}
for(const [id,file] of [['daily','wara-devnet.json'],['demo','wara-devnet-demo.json']]){
 const config=pk(manifest.instances[id].config),mint=pk(manifest.instances[id].mint),instance=await readInstance(connection,program,config);
 assert(instance.creator.equals(creator.publicKey));assert(instance.mint.equals(mint));
 const mintInfo=await getMint(connection,mint);assert(mintInfo.mintAuthority.equals(addresses(program,config).authority));assert.equal(mintInfo.decimals,0);assert.equal(mintInfo.freezeAuthority,null);
 const local=await readFile(`assets/${file}`),hosted=await publicFile(root+file);assert(local.equals(hosted),'Published JSON differs from local');
 const json=JSON.parse(local),image=await publicFile(json.image),localImage=await readFile('assets/wara-avatar.png');assert(image.equals(localImage),'Published avatar differs from local');
 const metadata=metadataAddress(mint),before=await snapshot(mint);let signature=null;
 const existing=await connection.getAccountInfo(metadata);
 if(!existing){
  if(dry)throw Error(`${id}: metadata not yet registered`);
  signature=await send([ComputeBudgetProgram.setComputeUnitLimit({units:300_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),createMetadataInstruction(program,config,creator.publicKey,{name:json.name,symbol:json.symbol,uri:root+file})],[creator]);
 }
 const account=await connection.getAccountInfo(metadata);assert(account.owner.equals(METADATA_PROGRAM));
 const decoded=decodeMetadata(account.data);
 assert.equal(decoded.mint,String(mint));assert.equal(decoded.updateAuthority,String(creator.publicKey));
 assert.equal(decoded.name,json.name);assert.equal(decoded.symbol,json.symbol);assert.equal(decoded.uri,root+file);
 assert.equal(decoded.tokenStandard,2);assert.equal(decoded.isMutable,1);assert.equal(decoded.sellerFeeBasisPoints,0);
 const after=await snapshot(mint);assert.deepEqual(after,before,'Supply, holders or protocol state changed during registration; inspect concurrent activity');
 evidence.instances[id]={mint:String(mint),metadata:String(metadata),...decoded,signature:signature||previous?.instances?.[id]?.signature||null,supply:mintInfo.supply.toString(),holderCount:before.holderCount,unchanged:{mint:true,tokenAccounts:true,protocolState:true},image:json.image,imageSha256:createHash('sha256').update(image).digest('hex')};
 console.log(`${id}: ${decoded.name} (${decoded.symbol}), supply ${mintInfo.supply}; balances and rights unchanged`);
 if(!dry)await save('deployments/devnet-metadata.json',evidence);
}
if(dry)console.log('On-chain metadata and public image verified. No transactions sent.');
