import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey} from '@solana/web3.js';
import {createRequest,parseRequest,REQUEST_TTL} from '../app/qr-protocol.mjs';
import {roundtrip} from './qr-roundtrip.mjs';
const key=()=>Keypair.generate().publicKey,context={program:key(),config:key(),mint:key()},recipient=key(),now=1700000000000;
const raw=()=>createRequest(context,recipient,100,'となりの八百屋',now);
test('checkout QR roundtrip preserves recipient, amount and Japanese label',()=>{
 for(const scale of [2,4,6]){const r=parseRequest(roundtrip(raw(),scale),context,now);assert.equal(r.recipient,String(recipient));assert.equal(r.amount,'100');assert.equal(r.label,'となりの八百屋');}
});
test('checkout rejects foreign network, instance, mint, schema and untrusted fields',()=>{
 for(const [field,value] of Object.entries({cluster:'mainnet-beta',program:String(key()),config:String(key()),mint:String(key()),schema:'other',recipient:'invalid',amount:'01',label:'bad\nname'})){
  const r=JSON.parse(raw());r[field]=value;assert.throws(()=>parseRequest(JSON.stringify(r),context,now),field);
 }
 const offcurve=PublicKey.findProgramAddressSync([Buffer.from('test')],context.program)[0];
 assert.throws(()=>createRequest(context,offcurve,100,'',now));
 for(const value of ['0','-1','1.2','1e2','18446744073709551616'])assert.throws(()=>createRequest(context,recipient,value,'',now));
 assert.equal(parseRequest(createRequest(context,recipient,'18446744073709551615','',now),context,now).amount,'18446744073709551615');
});
test('checkout expiry and clock skew are checked on each use',()=>{
 assert.throws(()=>parseRequest(raw(),context,now+REQUEST_TTL));
 assert.throws(()=>parseRequest(raw(),context,now-30001));
 const altered=JSON.parse(raw());altered.expiresAt++;assert.throws(()=>parseRequest(JSON.stringify(altered),context,now));
 for(const value of ['null','[]','{}','x'.repeat(1001)])assert.throws(()=>parseRequest(value,context,now));
});
