// After npm run build, run with Playwright installed: node tests/shop-directory.browser.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import bs58 from "bs58";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import manifest from "../deployments/devnet.json" with {type:"json"};
import { DEVNET_GENESIS } from "../app/protocol.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const key = () => String(Keypair.generate().publicKey);
const who = key(), admin = key(), origin = "https://wara.test";
const groups = ["所属中","開設済み","自由参加","申請中","川辺の市場"].map((name,i) => ({
  tag:31,id:i === 4 ? "4SuDmQR72DnjC5GZ78oDk7u4G2w5edNFuVGKFRfEZsLU" : key(),
  name,category:"地域",visibility:"public",owner:i === 1 || i === 4 ? who : admin,mode:0,
}));
const stores = groups.map((g,i) => ({tag:32,id:key(),group:g.id,name:g.name+"の店",to:i === 0 || i === 4 ? who : key()}));
const rows = [...groups,...stores,...[0,3].map(i=>({tag:33,id:key(),to:who,group:groups[i].id,status:i === 0 ? 2 : 1}))];
let profile = {shop:stores[0].id,title:"パン屋",caption:"手ごね",icon:"🥐",is_test:true,revision:1};
let paid = false, signatureReads = 0;
const paidSignature = bs58.encode(Buffer.alloc(64, 9));
const paymentData = Buffer.alloc(25); paymentData[0] = 14; paymentData.writeBigUInt64LE(3n, 1);
const chainRows = rows.map(row => {
  const keys = row.tag === 31 ? [row.owner] : [row.group, row.to];
  const data = Buffer.concat([Buffer.from([row.tag]), ...keys.map(k => new PublicKey(k).toBuffer()),
    row.tag === 31 ? Buffer.concat([Buffer.from([row.mode]), SystemProgram.programId.toBuffer(), Buffer.from(JSON.stringify({name:row.name,description:"",category:row.category}))]) :
    row.tag === 32 ? Buffer.from(row.name) : Buffer.from([row.status])]);
  return {pubkey:row.id,account:{owner:manifest.program,data:[data.toString("base64"),"base64"],lamports:1,executable:false,rentEpoch:0}};
});
const browser = await chromium.launch({executablePath:process.env.CHROME_BIN});
try {
  const page = await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(({who,prog,rows})=>{
    localStorage.setItem("wara.member",JSON.stringify({session:"local-browser-test",profile:{address:who,type:"phantom",managed:true},expires:Date.now()+600000}));
    sessionStorage.setItem("wara.v03.policy-directory."+prog,JSON.stringify({rows,at:Date.now()}));
  },{who,prog:manifest.program,rows});
  await page.route("**/*",async route=>{
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) {
      const cors = {"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"};
      if (req.method() === "OPTIONS") return route.fulfill({status:204,headers:cors});
      const {method,id,params} = req.postDataJSON();
      const clock = {owner:String(SystemProgram.programId),data:[Buffer.alloc(40).toString("base64"),"base64"],lamports:1,executable:false,rentEpoch:0};
      const tokens = Buffer.alloc(165); tokens[108] = 1; tokens.writeBigUInt64LE(1000n,64);
      if (method === "getSignaturesForAddress") signatureReads++;
      const result = method === "getGenesisHash" ? DEVNET_GENESIS :
        method === "getMultipleAccounts" ? {context:{slot:1},value:params[0].map((_,i)=>i === 0 ? clock : i === 1 ? null :
          {...clock,owner:String(TOKEN_PROGRAM_ID),data:[tokens.toString("base64"),"base64"]})} :
        method === "getProgramAccounts" ? chainRows :
        method === "getSignaturesForAddress" ? paid && params[1]?.until !== paidSignature ? [{signature:paidSignature,slot:2,blockTime:Math.floor(Date.now()/1000),err:null,memo:null,confirmationStatus:"confirmed"}] : [] :
        method === "getTransaction" ? {slot:2,blockTime:Math.floor(Date.now()/1000),version:"legacy",
          meta:{err:null,fee:5000,preBalances:[1,1,1,1],postBalances:[1,1,1,1]},
          transaction:{signatures:[paidSignature],message:{
            header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:1},
            accountKeys:[admin,groups[0].id,who,manifest.program],recentBlockhash:groups[0].id,
            instructions:[{programIdIndex:3,accounts:[0,1,2],data:bs58.encode(paymentData)}],
          }}} : [];
      return route.fulfill({json:{id,jsonrpc:"2.0",result},headers:cors});
    }
    if (url.pathname === "/api/member/shop-save") {
      const {title,caption,icon,is_test} = req.postDataJSON();
      assert.equal(is_test,true); // Editing a legacy shop must not reset its stored flag.
      profile = {...profile,title,caption,icon,is_test,revision:2};
      return route.fulfill({json:profile});
    }
    if (url.pathname === "/api/member/shop-profiles") return route.fulfill({json:{profiles:[profile]}});
    if (url.pathname.startsWith("/api/")) return route.fulfill({json:{}});
    return route.fulfill({path:resolve("dist","."+(url.pathname.endsWith("/") ? url.pathname+"index.html" : url.pathname))});
  });
  await page.goto(origin+"/shop/?mode=receive");
  await page.getByRole("link",{name:"🥐 パン屋"}).click();
  await page.getByText("⚙️ 店舗情報を編集").click();
  assert.equal(await page.locator("#edit-shop input[type=checkbox]").count(),0);
  assert.equal(await page.getByText("テスト店舗",{exact:true}).count(),0);
  await page.locator("#edit-shop select").selectOption("🦊");
  await page.getByRole("button",{name:"店舗情報を保存"}).click();
  await page.getByRole("heading",{name:"🦊 パン屋"}).waitFor();
  await page.goto(origin+"/communities/");
  await page.getByRole("link",{name:/🦊 パン屋/}).waitFor();
  assert.deepEqual(await page.locator(".market-row strong").allTextContents(),groups.slice(0,4).map(g=>g.name));
  await page.goto(origin+"/shop/");
  await page.getByRole("link",{name:"🦊 パン屋"}).waitFor();
  assert.deepEqual(await page.locator('a[href^="/shop/?group="]').allTextContents(),["🦊 パン屋","開設済みの店"]);
  await page.goto(origin+"/shop/?mode=receive");
  await page.getByRole("link",{name:"🦊 パン屋"}).waitFor();
  assert.deepEqual(await page.locator('a[href^="/shop/?group="]').allTextContents(),["🦊 パン屋"]);
  // A non-member can still follow a public register link and see the existing invitation to join.
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[2].group,store:stores[2].to}));
  await page.getByRole("link",{name:"地域に参加して支払う"}).waitFor();
  // Three confirmations use native dialog controls; no browser confirm prompt.
  page.on("dialog", () => assert.fail("unexpected browser confirm"));
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[1].group,store:stores[1].to}));
  await page.locator("#ina").getByRole("button",{name:"金額を確認して支払う"}).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({path:"/tmp/wara-phase2-confirm.png"});
  await page.keyboard.press("Escape");
  await page.getByText("取り消しました。",{exact:true}).waitFor();
  await page.locator('#wara input[name="amount"]').fill("10");
  await page.locator("#wara button").click();
  await page.getByRole("dialog").getByRole("button",{name:"キャンセル"}).click();
  await page.goto(origin+"/communities/?id="+groups[1].id);
  await page.locator('#policy select[name="mode"]').selectOption("1");
  await page.locator("#policy button").click();
  await page.getByRole("dialog").waitFor();
  await page.mouse.click(1,1);
  await page.getByText("取り消しました。",{exact:true}).waitFor();

  // A real rendered QR arms the watcher; receipt detection updates toast AND history.
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[0].group,store:who}));
  await page.locator('#invoice input[name="ina"]').fill("3");
  await page.locator("#invoice button").click();
  await page.locator("#qr-out img").waitFor();
  await page.screenshot({path:"/tmp/wara-phase2-register.png"});
  paid = true;
  await page.locator("#crystal-toast").filter({hasText:"+270"}).waitFor({timeout:15000});
  await page.locator(".story").filter({hasText:"3 INA"}).waitFor();
  assert.equal(await page.locator("#qr-out").count(),0);
  const afterPayment = signatureReads;
  await page.waitForTimeout(5500);
  assert.equal(signatureReads,afterPayment,"payment stops the register watcher");
  await page.locator("#invoice button").click();
  await page.locator("#qr-out img").waitFor();
  await page.locator("#qr-out").evaluate(el=>el.remove());
  const afterRemoval = signatureReads;
  await page.waitForTimeout(5500);
  assert.equal(signatureReads,afterRemoval,"removing only the QR stops its watcher");
  console.log("390px: custom dialogs, live receipt/toast/history, QR cleanup passed");
  console.log("390px: profile edit, market, pay/receive lists and direct register link passed");
} finally { await browser.close(); }
