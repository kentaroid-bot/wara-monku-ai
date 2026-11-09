import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createTransferCheckedInstruction,createTransferInstruction} from '@solana/spl-token';
import {pk,addresses,paymentInstructions} from './protocol.mjs';
import {withReference} from './receipt.mjs';
import {historyReader,historySummary,jstDay} from './receipt-history.mjs';

// Read executed, top-level payment instructions, not the buyer's balance delta:
// a daily payment mints to the merchant and never debits the buyer's WARA account.
export function outgoingPayments(tx,context){
 if(!tx?.meta||tx.meta.err!==null)return [];
 const {payer,mint,program,config}=context,m=tx.transaction.message;
 if(String(addresses(program,config).mint)!==String(mint))return [];
 const keys=m.accountKeys??[...(m.staticAccountKeys??[]),...(tx.meta.loadedAddresses?.writable??[]),...(tx.meta.loadedAddresses?.readonly??[])];
 const source=getAssociatedTokenAddressSync(pk(mint),pk(payer)),entries=[];
 for(const [index,ix] of (m.instructions??m.compiledInstructions??[]).entries()){
  const accounts=ix.accounts??ix.accountKeyIndexes,data=typeof ix.data==='string'?Buffer.from(bs58.decode(ix.data)):Buffer.from(ix.data);
  let expected,method,recipient,value;
  if(String(keys[ix.programIdIndex])===String(program)&&data.length===25&&data[0]===2&&String(keys[accounts[0]])===String(payer)){
   recipient=String(keys[accounts[1]]);value=data.readBigUInt64LE(1);
   expected=paymentInstructions(program,config,payer,recipient,value,data.readBigInt64LE(9),data.readBigUInt64LE(17)).at(-1);method='daily';
  }else if(String(keys[ix.programIdIndex])===String(TOKEN_PROGRAM_ID)&&String(keys[accounts[0]])===String(source)&&((data.length===10&&data[0]===12)||(data.length===9&&data[0]===3))){
   const checked=data[0]===12,destIndex=accounts[checked?2:1],authority=keys[accounts[checked?3:2]];
   if(String(authority)!==String(payer))continue;
   const balances=[...(tx.meta.preTokenBalances??[]),...(tx.meta.postTokenBalances??[])];
   const destBalance=balances.find(b=>b.accountIndex===destIndex&&b.mint===String(mint)&&b.uiTokenAmount.decimals===0);
   const sourceBalance=balances.find(b=>b.accountIndex===accounts[0]&&b.mint===String(mint)&&b.owner===String(payer)&&b.uiTokenAmount.decimals===0);
   if(!destBalance?.owner||!sourceBalance)throw Error('支払先または支払元のトークン情報を取得できません。');
   recipient=destBalance.owner;value=data.readBigUInt64LE(1);
   expected=checked?createTransferCheckedInstruction(source,pk(mint),keys[destIndex],pk(payer),value,0):createTransferInstruction(source,keys[destIndex],pk(payer),value);
   method='credit';
  }else continue;
  if(value===0n||recipient===String(payer))continue;
  let reference=null;
  if(accounts.length===expected.keys.length+1){reference=String(keys[accounts.at(-1)]);expected=withReference(expected,reference);}
  if(!data.equals(expected.data)||accounts.length!==expected.keys.length)continue;
  if(!expected.keys.every((k,i)=>String(k.pubkey)===String(keys[accounts[i]])&&(!k.isSigner||m.isAccountSigner(accounts[i]))))continue;
  if(reference&&(m.isAccountSigner(accounts.at(-1))||m.isAccountWritable(accounts.at(-1))))continue;
  const signature=tx.transaction.signatures[0];
  entries.push({id:`${signature}:${index}`,signature,instructionIndex:index,amount:String(value),method,recipient,reference,blockTime:Number.isSafeInteger(tx.blockTime)?tx.blockTime:null,slot:tx.slot});
 }
 return entries;
}
export const paymentHistoryReader=(connection,context,cache)=>historyReader(connection,context,cache,{address:pk(context.payer),parse:outgoingPayments});
export function paymentSummary(state,now){
 const summary=historySummary(state,now),today=state.entries.filter(e=>e.blockTime!==null&&jstDay(e.blockTime)===jstDay(now));
 return {...summary,daily:today.filter(e=>e.method==='daily').reduce((n,e)=>n+BigInt(e.amount),0n),credit:today.filter(e=>e.method==='credit').reduce((n,e)=>n+BigInt(e.amount),0n)};
}
