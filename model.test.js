const {test} = require('node:test');
const assert = require('node:assert/strict');
const S = require('./model.js');
function conserved(s){assert.equal(s.issued,s.daily+s.fixed+s.supplier+s.expired);assert.equal(s.crystallized,s.fixed+s.supplier);}
test('a meal crystallizes once; unused allocation expires while earned credit survives',()=>{
 const s=S.create();const p=S.offer(s,100,'QR');assert.equal(s.fixed,0);assert.equal(p.is_crystallized,false);S.accept(s,p.id);assert.equal(s.lastReceipt.is_crystallized,true);
 assert.throws(()=>S.accept(s,p.id));assert.equal(s.daily,200);assert.equal(s.fixed,100);
 S.advance(s,S.DAY);assert.equal(s.daily,300);assert.equal(s.expired,200);assert.equal(s.fixed,100);conserved(s);
});
test('an unreceived offer cannot cross midnight or consume the next allocation',()=>{
 const s=S.create(),p=S.offer(s,100,'BLE');S.advance(s,16*3600);
 assert.equal(s.pending,null);assert.throws(()=>S.accept(s,p.id));assert.equal(s.fixed,0);assert.equal(s.expired,300);conserved(s);
});
test('the last second and exact midnight behave differently',()=>{
 const s=S.create();S.advance(s,16*3600-1);S.accept(s,S.offer(s,300,'PAPER').id);
 S.advance(s,1);assert.equal(s.day,2);assert.equal(s.daily,300);assert.equal(s.fixed,300);conserved(s);
});
test('reject invalid amounts, over-spending, and concurrent offers without mutation',()=>{
 const s=S.create();for(const n of [0,-1,NaN,Infinity,1.2,301,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>S.offer(s,n,'QR'));
 assert.throws(()=>S.offer(s,1,'OTHER'));assert.equal(s.daily,300);assert.equal(s.seq,0);
 S.offer(s,100,'QR');assert.throws(()=>S.offer(s,100,'BLE'));S.cancel(s);assert.equal(s.daily,300);conserved(s);
});
test('producer credit can circulate without new issuance or re-crystallization',()=>{
 const s=S.create();S.accept(s,S.offer(s,100,'QR').id);S.transfer(s,50);
 assert.equal(s.fixed,50);assert.equal(s.supplier,50);assert.throws(()=>S.transfer(s,51));assert.throws(()=>S.transfer(s,-1));
 S.advance(s,S.DAY*3);assert.equal(s.fixed,50);assert.equal(s.supplier,50);assert.equal(s.expired,800);conserved(s);
});
test('multiple days conserve allocation, accepted credit, and expiry',()=>{
 const s=S.create();for(let i=0;i<20;i++){S.accept(s,S.offer(s,37,'QR').id);S.transfer(s,11);S.advance(s,S.DAY);conserved(s);}
 assert.equal(s.crystallized,740);assert.equal(s.supplier,220);
});
