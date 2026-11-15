import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";
import { Keypair, Transaction, PublicKey, SystemProgram } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import QRCode from "qrcode";
import { addr, ata, mintFor, DEVNET_GENESIS } from "../shared/protocol.mjs";
import manifest from "../shared/deployment.mjs";
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle=(await build({stdin:{contents:`
import {wallet,senderWallet} from './mainstream/main.mjs';
import {loadState,program} from './mainstream/network.mjs';
import {paymentHistory} from './mainstream/history.mjs';
import {spend,transfer} from './shared/protocol.mjs';
import {payWithCard} from './mainstream/member-ui.mjs';
import {Transaction,PublicKey} from '@solana/web3.js';
window.senderTest={wallet,senderWallet,loadState,paymentHistory,spend,transfer,payWithCard,Transaction,PublicKey,program};
`,resolveDir:process.cwd()},bundle:true,write:false,platform:"browser",define:{global:"globalThis"},external:["/v3/google-phone.js"]})).outputFiles[0].text;
const origin="https://wara.test",program=new PublicKey(manifest.program);
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN});
try {
 for(const width of [320,390,1024]) for(const colorScheme of ["light","dark"]) {
  const main=Keypair.generate(),sender=Keypair.generate(),next=Keypair.generate(),shop=Keypair.generate(),fee=Keypair.generate(),group=Keypair.generate().publicKey;
  const who=String(main.publicKey),senderWho=String(sender.publicKey),shopWho=String(shop.publicKey),g=String(group);
  const now=Math.floor(Date.now()/1000),expires=(now+600)*1000;
  let active={managed:true,type:"phantom",address:who,senderAddress:senderWho,senderRotatedAt:now-31*86400,carriedDay:10,carriedSpent:3};
  const signatureRequests=[],historyReads=[],accountReads=[];
  let rotations=0,sessionStatus=200;const paymentSteps=[],cardSteps=[];
  const primarySig=bs58.encode(Buffer.alloc(64,1)),senderSig=bs58.encode(Buffer.alloc(64,2));
  const rows=[{tag:31,id:g,owner:who,mode:0,invite:who,name:"地域",description:"",category:"地域",visibility:"public"},
    ...[who,senderWho,shopWho].map((to,i)=>({tag:32,id:String(addr(program,"s3",group,to)),group:g,to,name:["自分の窓口","贈る用の窓口","仲間の窓口"][i]}))];
  const page=await browser.newPage({viewport:{width,height:850},colorScheme});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(({active,expires,rows,program})=>{
    if(!sessionStorage.getItem("browser-initialized")) {
      localStorage.setItem("wara.member",JSON.stringify({session:"browser-session",profile:active,expires}));
      sessionStorage.setItem("browser-initialized","1");
    }
    sessionStorage.setItem("wara.v03.policy-directory."+program,JSON.stringify({at:Date.now(),rows}));
    window.phantomCalls=0;
    const publicKey={toBase58:()=>active.address,toString:()=>active.address};
    window.phantom={solana:{isPhantom:true,publicKey,isConnected:true,async connect(){window.phantomCalls++;return {publicKey};},async signTransaction(tx){window.phantomCalls++;return tx;}}};
  },{active,expires,rows,program:String(program)});
  await page.route("**/*",async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin) {
      const headers={"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"};
      if(req.method()==="OPTIONS")return route.fulfill({status:204,headers});
      const {id,method,params}=req.postDataJSON();let result;
      const account=(data,owner=program)=>({data:[data.toString("base64"),"base64"],owner:String(owner),lamports:1,executable:false,rentEpoch:0});
      if(method==="getGenesisHash")result=DEVNET_GENESIS;
      else if(method==="getProgramAccounts")result=[];
      else if(method==="getMultipleAccounts") {
        accountReads.push(params[0]);
        const clock=Buffer.alloc(40);clock.writeBigInt64LE(10n*86400n-32400n,32);
        const daily=Buffer.alloc(25);daily[0]=35;daily.writeBigInt64LE(10n,1);daily.writeBigUInt64LE(2n,9);daily.writeBigUInt64LE(4n,17);
        const token=Buffer.alloc(165);token[108]=1;token.writeBigUInt64LE(750n,64);
        result={context:{slot:1},value:[account(clock,SystemProgram.programId),account(daily),account(token,new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))]};
      } else if(method==="getAccountInfo") {
        const daily=Buffer.alloc(25);daily[0]=35;result={context:{slot:1},value:account(daily)};
      } else if(method==="getLatestBlockhash") result={context:{slot:1},value:{blockhash:g,lastValidBlockHeight:100}};
      else if(method==="getSignatureStatuses") result={context:{slot:1},value:[{slot:1,confirmations:1,err:null,confirmationStatus:"confirmed"}]};
      else if(method==="getSignaturesForAddress") {
        historyReads.push(params);
        result=params[0]===senderWho ? [{signature:senderSig,slot:3,blockTime:300,err:null,memo:null,confirmationStatus:"confirmed"},{signature:primarySig,slot:2,blockTime:200,err:null,memo:null,confirmationStatus:"confirmed"}]
          : [{signature:primarySig,slot:2,blockTime:200,err:null,memo:null,confirmationStatus:"confirmed"}];
      } else if(method==="getTransaction") {
        const outgoing=params[0]===senderSig;
        const data=Buffer.alloc(25);data[0]=14;data.writeBigUInt64LE(1n,1);
        result={slot:outgoing?3:2,blockTime:outgoing?300:200,version:"legacy",meta:{err:null,fee:5000,preBalances:[1,1,1,1],postBalances:[1,1,1,1]},transaction:{signatures:[params[0]],message:{header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:1},accountKeys:[outgoing?senderWho:shopWho,g,outgoing?shopWho:who,String(program)],recentBlockhash:g,instructions:[{programIdIndex:3,accounts:[0,1,2],data:bs58.encode(data)}]}}};
      } else throw Error("Unexpected browser RPC "+method);
      return route.fulfill({json:{id,jsonrpc:"2.0",result},headers});
    }
    if(url.pathname==="/api/member/session")return route.fulfill({status:sessionStatus,
      json:sessionStatus===200 ? {profile:active} : {error:sessionStatus===401 ? "セッションが失効しました。" : "一時的に利用できません。"}});
    if(url.pathname==="/api/auth/status")return route.fulfill({headers:{"X-Wara-Auth":"1"},json:{mode:"trial",version:3}});
    if(url.pathname==="/api/fee-payer")return route.fulfill({json:{feePayerPubkey:String(fee.publicKey)}});
    if(url.pathname==="/api/member/card-info") {cardSteps.push("info");return route.fulfill({json:{address:senderWho}});}
    if(url.pathname==="/api/member/card-prepare") {cardSteps.push("prepare");return route.fulfill({json:{prepared:true,carriedDay:10,carriedSpent:7}});}
    if(url.pathname==="/api/member/sender-join") {paymentSteps.push("join");return route.fulfill({json:{prepared:true}});}
    if(url.pathname==="/api/relay") {
      paymentSteps.push("relay");
      const tx=Transaction.from(Buffer.from(req.postDataJSON().tx,"base64"));
      assert.equal(String(tx.instructions.at(-1).keys[0].pubkey),senderWho);
      assert.equal(tx.instructions.at(-1).keys.length,10);
      return route.fulfill({json:{signature:bs58.encode(Buffer.alloc(64,7))}});
    }
    if(url.pathname==="/api/member/sign") {
      paymentSteps.push("sign");
      const tx=Transaction.from(Buffer.from(req.postDataJSON().tx,"base64"));signatureRequests.push(tx);
      return route.fulfill({json:{signature:Buffer.from(ed25519.sign(tx.serializeMessage(),sender.secretKey.slice(0,32))).toString("base64")}});
    }
    if(url.pathname==="/api/member/sender-rotate") {
      assert.equal(req.postDataJSON().pin,"123456");rotations++;
      active={...active,senderAddress:String(next.publicKey),senderRotatedAt:now,carriedSpent:5};
      return route.fulfill({json:{profile:active}});
    }
    if(url.pathname==="/api/member/shop-profiles")return route.fulfill({json:{profiles:[]}});
    if(url.pathname==="/api/member/payment-notes")return route.fulfill({json:{notes:[]}});
    if(url.pathname.startsWith("/api/"))return route.fulfill({json:{}});
    if(url.pathname==="/v3/main.js")return route.fulfill({contentType:"text/javascript",body:bundle});
    return route.fulfill({path:resolve("dist","."+(url.pathname.endsWith("/")?url.pathname+"index.html":url.pathname))});
  });
  await page.goto(origin+"/");await page.locator(".orb.ina").waitFor();
  assert.equal(await page.locator(".orb.ina strong").innerText(),"5");
  assert.equal(await page.locator(".orb.wara strong").innerText(),"750");
  assert.ok(accountReads.some(keys=>keys[1]===String(addr(program,"p3",senderWho)) && keys[2]===String(ata(mintFor(program,group),who))));
  await page.waitForFunction(()=>document.querySelectorAll(".stories li").length===2);
  const stories=await page.locator(".stories li").allTextContents();
  assert.match(stories[0],/贈りました/);assert.match(stories[1],/受け取りました/);assert.match(stories[0],/100 WARA/);
  assert.ok(historyReads.some(([address,options])=>address===who && options.limit===10));
  assert.ok(historyReads.some(([address,options])=>address===senderWho && options.limit===10));
  await page.evaluate(({g,shopWho})=>{
    window.cardResult=null;
    void window.senderTest.payWithCard(g,shopWho,3,"仲間の窓口").then(()=>window.cardResult="unexpected success",error=>window.cardResult=error.message);
  },{g,shopWho});
  const cardImage=await QRCode.toBuffer("wara:ina:"+senderWho,{margin:4,scale:6});
  await page.getByRole("dialog").locator('input[type="file"]').setInputFiles({name:"card.png",mimeType:"image/png",buffer:cardImage});
  await page.waitForFunction(()=>window.cardResult!==null);
  assert.equal(await page.evaluate(()=>window.cardResult),"今日のiineの残りを超えています。");
  assert.deepEqual(cardSteps,["info","prepare"]);
  assert.equal(await page.getByRole("dialog").count(),0);
  assert.equal(signatureRequests.length,0);
  await page.evaluate(async ({g,shopWho,senderWho})=>{
    const a=window.senderTest;
    const tx=new a.Transaction({feePayer:new a.PublicKey(senderWho),recentBlockhash:g}).add(...a.spend(a.program,senderWho,g,shopWho,1,10,4));
    const signer=await a.senderWallet();
    if(String(signer.publicKey)!==senderWho)throw Error("wrong sender");
    await signer.signTransaction(tx);
  },{g,shopWho,senderWho});
  assert.equal(signatureRequests.length,1);assert.equal(String(signatureRequests[0].instructions.at(-1).keys[0].pubkey),senderWho);
  assert.equal(await page.evaluate(()=>window.phantomCalls),0);
  assert.equal(await page.evaluate(async()=>String((await window.senderTest.wallet()).publicKey)),who);
  await page.goto(origin+"/shop/");await page.locator(".recipient-row").waitFor();
  assert.equal(await page.locator(".recipient-row").count(),1);
  assert.match(await page.locator(".recipient-row").innerText(),/仲間の窓口/);
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:g,store:senderWho}));
  await page.getByText("自分の贈る用アドレスには贈れません。").waitFor();
  assert.equal(await page.locator("#ina").count(),0);
  paymentSteps.length=0;
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:g,store:shopWho}));
  await page.locator("[data-tap]").click();
  await page.locator('#ina button[type="submit"]').click();
  await page.getByRole("dialog").getByRole("button",{name:"贈る",exact:true}).click();
  await page.getByText("贈りました。相手に 100 WARAが届きました。",{exact:false}).waitFor();
  assert.deepEqual(paymentSteps,["join","sign","relay"]);
  assert.equal(await page.evaluate(()=>window.phantomCalls),0);
  await page.goto(origin+"/account/");await page.locator(".sender-account").waitFor();
  assert.equal(await page.locator(".sender-address").innerText(),senderWho);
  assert.ok(await page.getByText(who,{exact:true}).count()>=1);
  const rotate=page.getByRole("button",{name:"贈る用アドレスを更新（月1回）"});assert.ok(await rotate.isEnabled());
  await rotate.click();await page.getByRole("dialog").getByRole("button",{name:"更新する",exact:true}).click();
  await page.getByLabel("アドレス更新の暗証番号").fill("123456");
  await page.getByText("贈る用アドレスを更新しました。",{exact:true}).waitFor();
  assert.equal(await page.locator(".sender-address").innerText(),String(next.publicKey));assert.ok(await rotate.isDisabled());
  assert.match(await page.locator(".sender-account").innerText(),/あと30日/);assert.equal(rotations,1);
  const session=await page.evaluate(()=>JSON.parse(localStorage.getItem("wara.member")));
  assert.equal(session.session,"browser-session");assert.equal(session.expires,expires);assert.equal(session.profile.address,who);assert.equal(session.profile.carriedSpent,5);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  if(process.env.SENDER_SCREENSHOT_DIR) {
    await (await import("node:fs/promises")).mkdir(process.env.SENDER_SCREENSHOT_DIR,{recursive:true});
    await page.screenshot({path:resolve(process.env.SENDER_SCREENSHOT_DIR,`${width}-${colorScheme}.png`),fullPage:true});
  }
  sessionStatus=503;
  await page.goto(origin+"/account/");
  await page.locator("#notice").getByText("一時的に利用できません。",{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,"/account/");
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem("wara.member"))),session);
  sessionStatus=401;
  await page.goto(origin+"/account/");
  await page.waitForURL(origin+"/signup/");
  const signin=page.getByRole("button",{name:"お名前でサインイン",exact:true});
  await signin.waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem("wara.member")),null);
  await signin.click();
  await page.getByRole("button",{name:"次へ",exact:true}).waitFor();
  // An expired session opened directly on signup also recovers without a redirect loop.
  await page.evaluate(session=>localStorage.setItem("wara.member",JSON.stringify({...session,profile:{...session.profile,type:"embedded"}})),session);
  await page.goto(origin+"/signup/");
  await page.getByRole("button",{name:"お名前でサインイン",exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem("wara.member")),null);
  assert.deepEqual(errors,[]);
  console.log(`PASS sender ${width}px ${colorScheme}: separate signer/quota/balance, merged history, self exclusion, PIN rotation, retained session, 401 signup recovery and 503 session preservation`);
  await page.close();
 }
} finally {await browser.close();}
