import assert from "node:assert/strict";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createGroup, certify, metadata, setAuthority, addr } from "../shared/protocol.mjs";
export function senderWorld(program = Keypair.generate().publicKey) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(String(program),process.env.STRAW_PROGRAM_SO || "target/deploy/straw_protocol.so");
  const [owner,authority,user,shop,outsider] = Array.from({length:5},()=>Keypair.generate());
  for(const k of [owner,authority,user,shop,outsider]) svm.airdrop(String(k.publicKey),5_000_000_000n);
  const clock=svm.getClock(); clock.unixTimestamp=1_800_000_000n; svm.setClock(clock);
  const programData = new PublicKey(svm.getAccount(String(program)).data.slice(4));
  const pd=svm.getAccount(String(programData)),bytes=Buffer.from(pd.data);
  bytes[12]=1;owner.publicKey.toBuffer().copy(bytes,13);svm.setAccount({...pd,data:bytes});
  function send(ix,...signers) {
    svm.expireBlockhash();
    const tx=new Transaction({feePayer:signers[0].publicKey,recentBlockhash:svm.latestBlockhash()}).add(...ix);
    tx.sign(...signers);return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  }
  const ok=r=>assert(!(r instanceof FailedTransactionMetadata),r.toString());
  const no=r=>assert(r instanceof FailedTransactionMetadata,"expected rejection");
  const account=k=>svm.getAccount(String(k));
  const group=(mode=2)=>{
    const g=Keypair.generate(),meta=metadata("地域","","地域");
    ok(send(createGroup(program,owner.publicKey,g.publicKey,mode,owner.publicKey,meta,Number(svm.minimumBalanceForRentExemption(BigInt(66+meta.length)))),owner,g));
    ok(send([certify(program,owner.publicKey,g.publicKey,shop.publicKey,"窓口")],owner));
    return g.publicKey;
  };
  const configure=()=>ok(send([setAuthority(program,owner.publicKey,authority.publicKey,programData)],owner));
  const day=()=> (svm.getClock().unixTimestamp+32400n)/86400n;
  const setPerson=(sender,spent,nonce=1n,d=day())=>{
    const data=Buffer.alloc(25);data[0]=35;data.writeBigInt64LE(d,1);data.writeBigUInt64LE(BigInt(spent),9);data.writeBigUInt64LE(nonce,17);
    svm.setAccount({address:String(addr(program,"p3",sender)),lamports:1_000_000n,data,programAddress:String(program),executable:false});
  };
  return {svm,program,programData,owner,authority,user,shop,outsider,send,ok,no,account,group,configure,day,setPerson};
}
