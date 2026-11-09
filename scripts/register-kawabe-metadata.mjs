// Register or inspect the existing Kawabe Devnet mint. Use --apply to write.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { connection, send } from './devnet-common.mjs';
import { assertDevnet, pk } from '../app/protocol.mjs';
import { parseRow, mintFor } from '../mainstream/protocol.mjs';
import { metadataAddress, METADATA_PROGRAM, decodeMetadata, createCommunityMetadataInstruction } from './token-metadata.mjs';

await assertDevnet(connection);
const program=pk('B58EpKJJq6YFJbY7QTdVek6Dh2TPeTx1D2Pvnvvvi6V8');
const group=pk('4SuDmQR72DnjC5GZ78oDk7u4G2w5edNFuVGKFRfEZsLU');
const mint=mintFor(program,group);
assert.equal(String(mint),'BHW9Z1vnhzaXpqXWHvcpQtHk4xVMHrJeZzdMWxKoCrNC');
const account=await connection.getAccountInfo(group);
assert(account.owner.equals(program));
const region=parseRow(account.data,String(group));
assert.equal(region.tag,31);assert.equal(region.name,'川辺の市場');
const uri='https://raw.githubusercontent.com/kentaroid-bot/wara-monku-ai/main/assets/kawabe-wara.json';
async function hosted(url,path){
 const response=await fetch(url);
 assert(response.ok,'Cannot load '+url);
 const bytes=Buffer.from(await response.arrayBuffer());
 assert(bytes.equals(await readFile(path)),'Host differs from '+path);
 return bytes;
}
const {name,symbol,image}=JSON.parse(await hosted(uri,'assets/kawabe-wara.json'));
assert.equal(name,region.name+' WARA');assert.equal(symbol,'WARA');
await hosted(image,'assets/wara-avatar.png');
const info=await getMint(connection,mint);
assert(info.mintAuthority.equals(mint));assert.equal(info.decimals,0);
const address=metadataAddress(mint);
if(!await connection.getAccountInfo(address)){
 assert(process.argv.includes('--apply'),'Not registered. Use --apply after reviewing the public files.');
 const owner=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile('private/v03-fixture-region-b.json','utf8'))));
 assert.equal(String(owner.publicKey),region.owner);
 const sig=await send([ComputeBudgetProgram.setComputeUnitLimit({units:300000}),
   createCommunityMetadataInstruction(program,group,owner.publicKey,{name,symbol,uri})],[owner]);
 console.log('Registered',sig);
}
const metadata=await connection.getAccountInfo(address);
assert(metadata.owner.equals(METADATA_PROGRAM));
const decoded=decodeMetadata(metadata.data);
for(const [key,expected] of Object.entries({mint:String(mint),name,symbol,uri,updateAuthority:region.owner,tokenStandard:2,sellerFeeBasisPoints:0})){
 assert.equal(decoded[key],expected,key);
}
console.log(name,symbol,String(address),image);
