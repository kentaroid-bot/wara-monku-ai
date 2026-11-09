import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createTransferCheckedInstruction} from '@solana/spl-token';
import {pk,paymentInstructions} from './protocol.mjs';
import {withReference} from './receipt.mjs';

export const jstDay=seconds=>Math.floor((seconds+32400)/86400);
export function incomingReceipt(tx,context){
 if(!tx?.meta||tx.meta.err!==null)return null;
 const {mint,recipient,program,config}=context,meta=tx.meta,m=tx.transaction.message;
 const keys=m.accountKeys??[...(m.staticAccountKeys??[]),...(meta.loadedAddresses?.writable??[]),...(meta.loadedAddresses?.readonly??[])];
 const dest=getAssociatedTokenAddressSync(pk(mint),pk(recipient)),index=keys.findIndex(k=>String(k)===String(dest));
 if(index<0||!Array.isArray(meta.preTokenBalances)||!Array.isArray(meta.postTokenBalances))throw Error('受取口座の履歴情報が不足しています。');
 const pre=meta.preTokenBalances.find(b=>b.accountIndex===index),post=meta.postTokenBalances.find(b=>b.accountIndex===index);
 const valid=b=>b.mint===String(mint)&&b.owner===String(recipient)&&b.uiTokenAmount.decimals===0;
 if((pre&&!valid(pre))||(post&&!valid(post)))throw Error('履歴のトークン口座が一致しません。');
 const delta=BigInt(post?.uiTokenAmount.amount??'0')-BigInt(pre?.uiTokenAmount.amount??'0');
 if(delta<=0n)return null;
 let method='other',reference=null,payer=null;
 // Describe only known, exact payment shapes; other positive changes remain
 // visible but are never mislabelled as a matched checkout or daily issuance.
 for(const ix of m.instructions??[]){try{
  const data=Buffer.from(bs58.decode(ix.data)),authority=keys[ix.accounts[0]];let expected,kind;
  if(String(keys[ix.programIdIndex])===String(program)&&data.length===25&&data[0]===2){
   expected=paymentInstructions(program,config,authority,recipient,delta,data.readBigInt64LE(9),data.readBigUInt64LE(17)).at(-1);kind='daily';
  }else if(String(keys[ix.programIdIndex])===String(TOKEN_PROGRAM_ID)){
   const sender=keys[ix.accounts[3]];
   expected=createTransferCheckedInstruction(getAssociatedTokenAddressSync(pk(mint),sender),pk(mint),dest,sender,delta,0);kind='credit';
  }else continue;
  let ref=null;
  if(ix.accounts.length===expected.keys.length+1){ref=String(keys[ix.accounts.at(-1)]);expected=withReference(expected,ref);}
  if(!data.equals(expected.data)||ix.accounts.length!==expected.keys.length)continue;
  if(!expected.keys.every((k,i)=>String(k.pubkey)===String(keys[ix.accounts[i]])&&(!k.isSigner||m.isAccountSigner(ix.accounts[i]))))continue;
  if(ref&&(m.isAccountSigner(ix.accounts.at(-1))||m.isAccountWritable(ix.accounts.at(-1))))continue;
  method=kind;reference=ref;payer=String(kind==='daily'?authority:keys[ix.accounts[3]]);break;
 }catch{}}
 return {signature:tx.transaction.signatures[0],amount:String(delta),blockTime:Number.isSafeInteger(tx.blockTime)?tx.blockTime:null,slot:tx.slot,method,reference,payer};
}

// Pages are fetched newest first. A failed/partial page never advances the cursor.
// Cache only confirmed transaction bodies; never cache absent/indexing-lag data.
export function historyReader(connection,context,cache=new Map(),adapter={}){
 const address=adapter.address??getAssociatedTokenAddressSync(pk(context.mint),pk(context.recipient));
 const parse=adapter.parse??incomingReceipt;
 let before,done=false,oldest=null,unknownTime=false,pages=0;const entries=new Map(),seen=new Set();
 const snapshot=()=>({entries:[...entries.values()].sort((a,b)=>b.slot-a.slot),done,oldest,unknownTime,pages});
 return {snapshot,async load(){
  if(done)return snapshot();
  const rows=await connection.getSignaturesForAddress(address,{limit:20,...(before?{before}:{})},'confirmed');
  const receipts=[];
  for(const row of rows){
   if(row.err)continue;
   if(!['confirmed','finalized'].includes(row.confirmationStatus))throw Error('履歴の確定を待っています。');
   let tx=cache.get(row.signature);
   if(!tx){tx=await connection.getTransaction(row.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});if(!tx)throw Error('履歴の取得待ちです。もう一度更新してください。');if(cache.size<1000)cache.set(row.signature,tx);}
   if(tx.transaction.signatures[0]!==row.signature)throw Error('履歴の署名が一致しません。');
   const parsed=parse(tx,context);receipts.push(...(Array.isArray(parsed)?parsed:[parsed]));
  }
  for(const receipt of receipts){if(!receipt)continue;const id=receipt.id??receipt.signature;if(!seen.has(id)){seen.add(id);entries.set(id,receipt);}}
  for(const row of rows){if(Number.isSafeInteger(row.blockTime))oldest=oldest===null?row.blockTime:Math.min(oldest,row.blockTime);else if(!row.err)unknownTime=true;}
  done=rows.length<20;before=rows.at(-1)?.signature??before;pages++;return snapshot();
 }};
}
export function historySummary(state,nowSeconds){
 const day=jstDay(nowSeconds),today=state.entries.filter(e=>e.blockTime!==null&&jstDay(e.blockTime)===day);
 const complete=(state.done||(state.oldest!==null&&jstDay(state.oldest)<day))&&!state.unknownTime&&!state.entries.some(e=>e.blockTime===null);
 return {total:today.reduce((sum,e)=>sum+BigInt(e.amount),0n),count:today.length,complete};
}
