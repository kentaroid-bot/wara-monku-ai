// Minimal client for this program's creator-authorized metadata instruction.
import {PublicKey,TransactionInstruction,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {addresses} from '../app/protocol.mjs';
export const METADATA_PROGRAM=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const metadataAddress=mint=>PublicKey.findProgramAddressSync([Buffer.from('metadata'),METADATA_PROGRAM.toBuffer(),mint.toBuffer()],METADATA_PROGRAM)[0];
const string=s=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);};
export function createMetadataInstruction(program,config,creator,{name,symbol,uri}){
 const {mint,authority}=addresses(program,config,creator);
 return new TransactionInstruction({programId:program,keys:[
  {pubkey:creator,isSigner:true,isWritable:true},
  {pubkey:config,isSigner:false,isWritable:false},
  {pubkey:mint,isSigner:false,isWritable:true},
  {pubkey:authority,isSigner:false,isWritable:false},
  {pubkey:metadataAddress(mint),isSigner:false,isWritable:true},
  ...[METADATA_PROGRAM,SystemProgram.programId,SYSVAR_INSTRUCTIONS_PUBKEY,TOKEN_PROGRAM_ID].map(pubkey=>({pubkey,isSigner:false,isWritable:false})),
 ],data:Buffer.concat([Buffer.from([3]),string(name),string(symbol),string(uri)])});
}
// Read the standard MetadataV1 prefix. Optional trailing collection fields are not used.
export function decodeMetadata(bytes){
 const b=Buffer.from(bytes);let p=0;
 const take=n=>{if(p+n>b.length)throw Error('Truncated metadata');const v=b.subarray(p,p+n);p+=n;return v;};
 const u8=()=>take(1)[0],u32=()=>take(4).readUInt32LE(0),key=()=>new PublicKey(take(32)).toBase58();
 const str=()=>take(u32()).toString('utf8').replace(/\0+$/,'');
 if(u8()!==4)throw Error('Expected MetadataV1');
 const updateAuthority=key(),mint=key(),name=str(),symbol=str(),uri=str(),sellerFeeBasisPoints=take(2).readUInt16LE(0);
 const optional=read=>{const tag=u8();if(tag===0)return null;if(tag!==1)throw Error('Invalid option');return read();};
 optional(()=>take(u32()*34));
 const primarySaleHappened=u8(),isMutable=u8();optional(u8);const tokenStandard=optional(u8);
 return {updateAuthority,mint,name,symbol,uri,sellerFeeBasisPoints,primarySaleHappened,isMutable,tokenStandard};
}
