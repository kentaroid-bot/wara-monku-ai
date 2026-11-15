import test from "node:test";
import assert from "node:assert/strict";
import { Keypair,Transaction,ComputeBudgetProgram } from "@solana/web3.js";
import { inspect } from "../worker/relay.mjs";
import { spend,transfer,pk } from "../shared/protocol.mjs";
import { sponsoredInstructions } from "../shared/sponsorship.mjs";
import manifest from "../shared/deployment.mjs";
const program=pk(manifest.program);
test("relay separates sender and main identities, rejects both self destinations and admits another card at its cashier",()=>{
  const [main,sender,shop,card,fee,group]=Array.from({length:6},()=>Keypair.generate());
  const member={address:String(main.publicKey),senderAddress:String(sender.publicKey)};
  const wire=(actor,recipient,ina=true)=>{
    const original=ina?spend(program,actor.publicKey,group.publicKey,recipient,1,10,0):transfer(program,actor.publicKey,group.publicKey,recipient,[{origin:group.publicKey,amount:1n}]);
    const tx=new Transaction({feePayer:fee.publicKey,recentBlockhash:String(group.publicKey)}).add(...sponsoredInstructions([ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),...original],fee.publicKey,0));
    tx.partialSign(actor);return tx.serialize({requireAllSignatures:false}).toString("base64");
  };
  assert.ok(inspect(wire(sender,shop.publicKey),fee.publicKey,member));
  for(const target of [main.publicKey,sender.publicKey])assert.throws(()=>inspect(wire(sender,target),fee.publicKey,member));
  assert.throws(()=>inspect(wire(main,shop.publicKey),fee.publicKey,member));
  assert.throws(()=>inspect(wire(card,shop.publicKey),fee.publicKey,member));
  assert.ok(inspect(wire(card,main.publicKey),fee.publicKey,member));
  assert.throws(()=>inspect(wire(main,main.publicKey),fee.publicKey,member));
  assert.ok(inspect(wire(main,shop.publicKey,false),fee.publicKey,member));
  assert.throws(()=>inspect(wire(sender,shop.publicKey,false),fee.publicKey,member));
  assert.ok(inspect(wire(main,shop.publicKey),fee.publicKey,member.address));
});
