import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createTransferCheckedInstruction} from '@solana/spl-token';
import {pk, paymentInstructions} from './protocol.mjs';

// Public correlation key, not a signing key or an on-chain uniqueness constraint.
export function withReference(instruction, reference) {
 if (!reference) return instruction; // v1 QR / manual-address payment
 const ref=pk(reference);
 if (instruction.keys.some(k=>k.pubkey.equals(ref)) || instruction.programId.equals(ref)) throw Error('お会計番号が支払い口座と重複しています。QRを作り直してください。');
 return new TransactionInstruction({programId:instruction.programId,data:instruction.data,
  keys:[...instruction.keys,{pubkey:ref,isSigner:false,isWritable:false}]});
}

// Accept only the app's legacy, single-payer payment shapes. Verify the actual
// recipient token delta as well: a reference alone is never proof of payment.
export function matchReceipt(tx, request, minSlot=0) {
 try {
  if (!request.reference || !tx?.meta || tx.meta.err!==null || tx.slot<minSlot) return null;
  if (!Array.isArray(tx.meta.preTokenBalances) || !Array.isArray(tx.meta.postTokenBalances)) return null;
  const m=tx.transaction.message, keys=m.accountKeys;
  if (!keys || m.header.numRequiredSignatures!==1 || tx.transaction.signatures.length!==1) return null;
  const payer=keys[0], refIndex=keys.findIndex(k=>String(k)===request.reference);
  if (refIndex<0 || m.isAccountSigner(refIndex) || m.isAccountWritable(refIndex) || String(payer)===request.recipient) return null;
  const dest=getAssociatedTokenAddressSync(pk(request.mint),pk(request.recipient)), value=BigInt(request.amount);
  const relevant=m.instructions.filter(ix=>ix.accounts.includes(refIndex));
  if (relevant.length!==1) return null;
  const ix=relevant[0], data=Buffer.from(bs58.decode(ix.data));
  let expected, method;
  if (String(keys[ix.programIdIndex])===request.program && data.length===25 && data[0]===2) {
   expected=paymentInstructions(request.program,request.config,payer,request.recipient,value,data.readBigInt64LE(9),data.readBigUInt64LE(17)).at(-1);
   method='daily';
  } else if (keys[ix.programIdIndex].equals(TOKEN_PROGRAM_ID)) {
   expected=createTransferCheckedInstruction(getAssociatedTokenAddressSync(pk(request.mint),payer),pk(request.mint),dest,payer,value,0);
   method='credit';
  } else return null;
  expected=withReference(expected,request.reference);
  if (!data.equals(expected.data) || ix.accounts.length!==expected.keys.length) return null;
  if (!expected.keys.every((k,i)=>k.pubkey.equals(keys[ix.accounts[i]]) && (!k.isSigner||m.isAccountSigner(ix.accounts[i])))) return null;
  const destIndex=keys.findIndex(k=>k.equals(dest));
  const pre=tx.meta.preTokenBalances?.find(b=>b.accountIndex===destIndex);
  const post=tx.meta.postTokenBalances?.find(b=>b.accountIndex===destIndex);
  const valid=b=>b && b.mint===request.mint && b.owner===request.recipient && b.uiTokenAmount.decimals===0;
  if (!valid(post) || (pre&&!valid(pre))) return null;
  if (BigInt(post.uiTokenAmount.amount)-BigInt(pre?.uiTokenAmount.amount??'0')!==value) return null;
  return {signature:tx.transaction.signatures[0],amount:String(value),payer:String(payer),method,slot:tx.slot};
 } catch { return null; }
}

// Each request owns its cache. Null/indexing-lag responses are retried; errors
// propagate to the UI as unconfirmed. Pages are bounded, never a success shortcut.
export function receiptLookup(connection, request, minSlot=0) {
 const checked=new Set();
 return async function check() {
  let before;
  for(let page=0;page<5;page++) {
   const rows=await connection.getSignaturesForAddress(pk(request.reference),{limit:20,...(before?{before}:{})},'confirmed');
   for(const row of rows) {
    if(row.slot<minSlot) return null;
    if(row.err || checked.has(row.signature) || !['confirmed','finalized'].includes(row.confirmationStatus)) continue;
    const tx=await connection.getTransaction(row.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
    if(!tx) continue;
    const receipt=matchReceipt(tx,request,minSlot);
    if(receipt && receipt.signature===row.signature) return receipt;
    if(checked.size<1000) checked.add(row.signature);
   }
   if(rows.length<20) return null;
   before=rows.at(-1).signature;
  }
  throw Error('お会計番号への取引が多いため、自動照合を完了できません。Explorerで確認してください。');
 };
}
