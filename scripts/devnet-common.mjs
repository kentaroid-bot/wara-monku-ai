import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {Connection,Keypair,Transaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {assertDevnet} from '../app/protocol.mjs';
export const connection=new Connection('https://api.devnet.solana.com','confirmed');
export async function key(name){await mkdir('private',{recursive:true,mode:0o700});const path=`private/${name}.json`;try{return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path,'utf8'))));}catch(e){if(e.code!=='ENOENT')throw e;const k=Keypair.generate();await writeFile(path,JSON.stringify([...k.secretKey]),{mode:0o600,flag:'wx'});return k;}}
export async function payer(){await assertDevnet(connection);const k=await key('devnet-payer');await chmod('private/devnet-payer.json',0o600);return k;}
export async function send(instructions,signers){
 await assertDevnet(connection);const latest=await connection.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:signers[0].publicKey,recentBlockhash:latest.blockhash}).add(...instructions);tx.sign(...signers);
 const signature=bs58.encode(tx.signature);
 // Public RPC websocket availability is not assumed. Poll the same signature over HTTP.
 try{await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});}
 catch(e){throw Error(`${e.message}\nTransaction signature (check before retrying): ${signature}`);}
 try{for(let i=0;i<40;i++){
  const {value:[status]}=await connection.getSignatureStatuses([signature],{searchTransactionHistory:true});
  if(status?.err)throw Error(`Transaction failed: ${JSON.stringify(status.err)}; signature: ${signature}`);
  if(status&&['confirmed','finalized'].includes(status.confirmationStatus))return signature;
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
 throw Error('Confirmation unknown');
 }catch(e){throw Error(`${e.message}\nCheck before retrying: https://explorer.solana.com/tx/${signature}?cluster=devnet`);}
}
export async function save(path,value){await writeFile(path,JSON.stringify(value,null,2)+'\n');}
