import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { authorityPda,setAuthority,sponsorJoin,closeSenderPda,closeSenderMember,join,endMembership,spend,addr,ata,mintFor } from "../shared/protocol.mjs";
import { senderWorld } from "./sender-fixture.mjs";

test("authority requires the current loader upgrade signer; updates in place and preserves existing layouts",()=>{
  const w=senderWorld(),{program:p,programData:pd,owner,authority,outsider,send,no,ok,account}=w;
  no(send([setAuthority(p,outsider.publicKey,authority.publicKey,pd)],outsider));
  for(const field of ["option","key","tag","short","owner"]) {
    const original=account(pd),d=Buffer.from(original.data);
    if(field==="option")d[12]=0;
    if(field==="key")outsider.publicKey.toBuffer().copy(d,13);
    if(field==="tag")d.writeUInt32LE(2,0);
    w.svm.setAccount({...original,data:field==="short"?d.subarray(0,44):d,programAddress:field==="owner"?String(SystemProgram.programId):original.programAddress});
    no(send([setAuthority(p,owner.publicKey,authority.publicKey,pd)],owner));
    w.svm.setAccount(original);
  }
  const wrongProgram=setAuthority(p,owner.publicKey,authority.publicKey,pd);wrongProgram.keys[2].pubkey=outsider.publicKey;
  no(send([wrongProgram],owner));
  const wrongData=setAuthority(p,owner.publicKey,authority.publicKey,outsider.publicKey);no(send([wrongData],owner));
  const wrongPda=setAuthority(p,owner.publicKey,authority.publicKey,pd);wrongPda.keys[1].pubkey=outsider.publicKey;no(send([wrongPda],owner));
  w.configure();const before=account(authorityPda(p));assert.equal(before.data.length,33);assert.equal(before.data[0],36);
  ok(send([setAuthority(p,owner.publicKey,outsider.publicKey,pd)],owner));
  assert.equal(account(authorityPda(p)).lamports,before.lamports);
  assert.deepEqual(Buffer.from(account(authorityPda(p)).data.slice(1)),outsider.publicKey.toBuffer());
});

test("sponsor join approves absent/pending/left/approved only and rejects banned, forged authority and owner targets",()=>{
  const w=senderWorld(),{program:p,owner,authority,user,outsider,send,ok,no,account}=w;w.configure();const g=w.group();
  const ix=()=>sponsorJoin(p,authority.publicKey,g,user.publicKey);
  no(send([sponsorJoin(p,user.publicKey,g,user.publicKey)],user));
  no(send([sponsorJoin(p,authority.publicKey,g,owner.publicKey)],authority));
  const wrong=ix();wrong.keys[4].pubkey=outsider.publicKey;no(send([wrong],authority));
  const wrongRow=ix();wrongRow.keys[3].pubkey=addr(p,"m3",g,outsider.publicKey);no(send([wrongRow],authority));
  ok(send([ix()],authority));ok(send([ix()],authority));
  assert.equal(account(addr(p,"m3",g,user.publicKey)).data[65],2);
  ok(send([endMembership(p,user.publicKey,g,user.publicKey,false)],user));ok(send([ix()],authority));
  ok(send([endMembership(p,owner.publicKey,g,user.publicKey,true)],owner));no(send([ix()],authority));
  const another=w.group();ok(send([join(p,user.publicKey,another,user.publicKey)],user));
  ok(send([sponsorJoin(p,authority.publicKey,another,user.publicKey)],authority));
});

test("spend issues 100 to recipient without sender ATA and closes p3/m3 only with application authority",()=>{
  const w=senderWorld(),{program:p,owner,authority,user,shop,outsider,send,ok,no,account}=w;w.configure();const g=w.group();
  ok(send([sponsorJoin(p,authority.publicKey,g,user.publicKey)],authority));
  const payment=spend(p,user.publicKey,g,shop.publicKey,3,w.day(),0);
  assert.equal(payment.at(-1).keys.length,10);assert.equal(payment.length,3);
  ok(send(payment,user));assert.equal(account(ata(mintFor(p,g),user.publicKey)).exists,false);
  assert.equal(Buffer.from(account(ata(mintFor(p,g),shop.publicKey)).data).readBigUInt64LE(64),300n);
  no(send(spend(p,user.publicKey,g,shop.publicKey,1,w.day(),0),user));
  no(send(spend(p,user.publicKey,g,shop.publicKey,8,w.day(),1),user));
  const extra=spend(p,user.publicKey,g,shop.publicKey,1,w.day(),1);extra.at(-1).keys.push({pubkey:owner.publicKey,isSigner:false,isWritable:false});no(send(extra,user));
  for(const kind of [0,1]) {
    const target=kind===0?addr(p,"p3",user.publicKey):addr(p,"m3",g,user.publicKey);
    const close=(auth,recipient)=>kind===0?closeSenderPda(p,auth,user.publicKey,recipient):closeSenderMember(p,auth,g,user.publicKey,recipient);
    no(send([close(user.publicKey,outsider.publicKey)],user));
    no(send([close(authority.publicKey,target)],authority));
    for(const index of kind===0?[2,3]:[3,4]) {const ix=close(authority.publicKey,outsider.publicKey);ix.keys[index].isWritable=false;no(send([ix],authority));}
    const malformed=account(target);w.svm.setAccount({...malformed,data:Buffer.alloc(malformed.data.length)});no(send([close(authority.publicKey,outsider.publicKey)],authority));w.svm.setAccount(malformed);
    const before=account(outsider.publicKey).lamports,rent=account(target).lamports;
    ok(send([close(authority.publicKey,outsider.publicKey)],authority));
    assert.equal(account(outsider.publicKey).lamports,before+rent);
    assert.equal(account(target).exists,false);
  }
});

test("close without auth3 or an authority signature cannot reset a wallet, even with a valid target PDA",()=>{
  const w=senderWorld(),{program:p,authority,user,outsider,send,no,ok,account}=w;
  w.setPerson(user.publicKey,6,2n);
  const target=addr(p,"p3",user.publicKey),before=account(target);
  no(send([closeSenderPda(p,authority.publicKey,user.publicKey,outsider.publicKey)],authority));
  assert.deepEqual(account(target).data,before.data);
  w.configure();
  const unsigned=closeSenderPda(p,authority.publicKey,user.publicKey,outsider.publicKey);unsigned.keys[0].isSigner=false;
  no(send([unsigned],outsider));
  const badAuth=account(authorityPda(p));
  w.svm.setAccount({...badAuth,programAddress:String(SystemProgram.programId)});
  no(send([closeSenderPda(p,authority.publicKey,user.publicKey,outsider.publicKey)],authority));
  w.svm.setAccount(badAuth);
  ok(send([closeSenderPda(p,authority.publicKey,user.publicKey,outsider.publicKey)],authority));
  assert.equal(account(target).exists,false);
});
