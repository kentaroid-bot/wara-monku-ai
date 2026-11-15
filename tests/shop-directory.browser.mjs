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
const stores = groups.map((g,i) => ({tag:32,id:key(),group:g.id,name:g.name+"の仲間",to:i === 0 || i === 4 ? who : key()}));
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
  const errors=[];
  page.on("pageerror", e=>errors.push(e.message));
  page.on("console", m=>{if(m.type()==="error") errors.push(m.text());});
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
    if (url.pathname === "/api/member/payment-notes") {
      const {receipts,session} = req.postDataJSON();
      assert.ok(session);
      return route.fulfill({json:{notes:receipts.some(r=>r.sig === paidSignature) ? [{sig:paidSignature,note:"また来ます <3"}] : []}});
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
  await page.getByText("⚙️ 受け取り窓口情報を編集").click();
  assert.equal(await page.locator("#edit-shop input[type=checkbox]").count(),0);
  assert.equal(await page.getByText("テスト受け取り窓口",{exact:true}).count(),0);
  await page.locator("#edit-shop select").selectOption("🦊");
  await page.getByRole("button",{name:"受け取り窓口情報を保存"}).click();
  await page.getByRole("heading",{name:"🦊 パン屋"}).waitFor();
  await page.goto(origin+"/communities/");
  await page.getByRole("link",{name:/🦊 パン屋/}).waitFor();
  assert.deepEqual(await page.locator(".market-row strong").allTextContents(),groups.slice(0,4).map(g=>g.name));
  await page.goto(origin+"/shop/");
  await page.getByRole("link",{name:/開設済みの仲間/}).waitFor();
  assert.equal(await page.locator("#screen h1").innerText(),"iineを贈る");
  const listedStores = () => page.locator('a[href^="/shop/?group="]').evaluateAll(links=>links.map(link=>new URL(link.href).searchParams.get("store")));
  // Own stores stay out of recipient choices; only other recipients in joined communities appear.
  assert.deepEqual(await listedStores(),[stores[1].to]);
  assert.equal(await page.getByRole("link",{name:/🦊 パン屋/}).count(),0);
  await page.goto(origin+"/shop/?mode=receive");
  await page.getByRole("link",{name:"🦊 パン屋"}).waitFor();
  assert.equal(await page.locator("#screen h1").innerText(),"受け取る");
  assert.deepEqual(await listedStores(),[stores[0].to]);
  // A non-member can still follow a public register link and see the existing invitation to join.
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[2].group,store:stores[2].to}));
  await page.getByRole("link",{name:"コミュニティに参加して贈る"}).waitFor();
  // Three confirmations use native dialog controls; no browser confirm prompt.
  page.on("dialog", () => assert.fail("unexpected browser confirm"));
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[1].group,store:stores[1].to}));
  await page.locator("[data-tap]").click();
  const feedback=page.locator("#ina .payment-memo");
  await feedback.locator("summary").click();
  const smile=feedback.getByRole("button",{name:"😊"});
  await smile.click(); assert.equal(await smile.getAttribute("aria-pressed"),"true");
  await smile.click(); assert.equal(await smile.getAttribute("aria-pressed"),"false");
  await feedback.getByRole("button",{name:"助かりました"}).click();
  assert.equal(await feedback.getByLabel("ひとこと").inputValue(),"助かりました");
  await feedback.getByLabel("ひとこと").fill("また来ます、ありがとう");
  await page.locator("#ina").getByRole("button",{name:"贈る"}).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({path:"/tmp/wara-phase2-confirm.png"});
  await page.keyboard.press("Escape");
  await page.getByText("取り消しました。",{exact:true}).waitFor();
  // A phone wallet can retain the previous site connection after the user switches accounts.
  await page.evaluate(({wrong,who})=>{
    let selected=wrong;
    const key=value=>({toBase58:()=>value,toString:()=>value});
    window.selectRegistered=()=>{ selected=who; };
    window.phantom={solana:{
      isPhantom:true,isConnected:true,publicKey:key(wrong),
      async connect(){ if(!this.isConnected) this.publicKey=key(selected); this.isConnected=true; return {publicKey:this.publicKey}; },
      async disconnect(){ this.isConnected=false; this.publicKey=null; },
    }};
  },{who,wrong:admin});
  await page.locator("#ina").getByRole("button",{name:"贈る"}).click();
  await page.getByRole("dialog").getByRole("button",{name:"贈る",exact:true}).click();
  const recheck=page.getByRole("button",{name:"Phantomの接続を確認する"});
  await recheck.waitFor();
  assert.ok((await page.locator("#notice").innerText()).includes(who.slice(-6)));
  await page.evaluate(()=>window.selectRegistered());
  await recheck.click();
  await page.getByText(/登録した財布に接続しました/).waitFor();
  assert.equal(await page.getByRole("dialog").count(),0);
  await page.locator(".wara-gift > summary").click();
  await page.locator('#wara input[name="amount"]').fill("10");
  await page.locator("#wara").getByRole("button",{name:"WARAを贈る"}).click();
  await page.getByRole("dialog").getByRole("button",{name:"キャンセル"}).click();
  await page.goto(origin+"/communities/?id="+groups[1].id);
  await page.locator('#policy select[name="mode"]').selectOption("1");
  await page.locator("#policy button").click();
  await page.getByRole("dialog").waitFor();
  await page.mouse.click(1,1);
  await page.getByText("取り消しました。",{exact:true}).waitFor();

  // A real rendered QR arms the watcher; receipt detection updates toast AND history.
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[0].group,store:who}));
  await page.locator('[data-invoice="3"]').click();
  await page.locator("#qr-out img").waitFor();
  await page.screenshot({path:"/tmp/wara-phase2-register.png"});
  paid = true;
  await page.locator("#crystal-toast").filter({hasText:"+270"}).waitFor({timeout:15000});
  await page.locator(".story").filter({hasText:"3 iine"}).waitFor();
  await page.locator(".story").getByText("ひとこと「また来ます <3」").waitFor();
  await page.locator("#qr-out img").waitFor();
  await page.locator("#qr-out").evaluate(el=>el.remove());
  const afterPayment = signatureReads;
  await page.waitForTimeout(5500);
  assert.equal(signatureReads,afterPayment,"payment stops the register watcher");
  await page.locator('#invoice button[type="submit"]').click();
  await page.locator("#qr-out img").waitFor();
  await page.locator("#qr-out").evaluate(el=>el.remove());
  const afterRemoval = signatureReads;
  await page.waitForTimeout(5500);
  assert.equal(signatureReads,afterRemoval,"removing only the QR stops its watcher");
  const screenshots = process.env.IINE_SCREENSHOT_DIR;
  if (screenshots) await (await import("node:fs/promises")).mkdir(screenshots,{recursive:true});
  for (const width of [320,390,1024]) for (const colorScheme of ["light","dark"]) {
    await page.setViewportSize({width,height:844}); await page.emulateMedia({colorScheme});
    const check = async name => {
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width}`);
      if (screenshots) await page.screenshot({path:resolve(screenshots,`${width}-${colorScheme}-${name}.png`),fullPage:true});
    };
    await page.goto(origin+"/"); await page.locator(".orb.ina").waitFor();
    assert.equal(await page.locator(".quick-actions").count(),0);
    assert.equal(await page.locator(".orb.ina").getAttribute("href"),"/shop/");
    await page.evaluate(()=>document.documentElement.style.setProperty("--warmth","0"));
    await check("home");
    const cool=await page.locator(".orb.ina").evaluate(el=>getComputedStyle(el).backgroundImage);
    await page.evaluate(()=>document.documentElement.style.setProperty("--warmth","1"));
    assert.notEqual(await page.locator(".orb.ina").evaluate(el=>getComputedStyle(el).backgroundImage),cool);
    await check("home-warm");
    await page.locator(".orb.ina").click(); await page.locator(".recipient-row").first().waitFor();
    assert.equal(await page.locator("#screen h1").innerText(),"iineを贈る");
    assert.match(await page.locator(".recipient-row").first().innerText(),/開設済み/); await check("recipients");
    await page.goto(origin+"/shop/?mode=receive"); await page.locator(".recipient-row").first().waitFor();
    assert.equal(await page.locator("#screen h1").innerText(),"受け取る");
    assert.match(await page.locator(".recipient-row").first().innerText(),/QRを出す/); await check("receivers");
    await page.locator(".recipient-row").first().click(); await page.locator("#qr-out img").waitFor();
    assert.equal(await page.locator("#screen h1").innerText(),"受け取る");
    assert.ok(!new URL(await page.locator("#qr-out a").getAttribute("href")).searchParams.has("ina"));
    for (const n of [1,3,5]) {
      await page.locator(`[data-invoice="${n}"]`).click();
      await page.waitForFunction(n=>document.querySelector("#qr-out a")?.href.endsWith("ina="+n),n);
    }
    await page.locator('#invoice input[name="custom"]').fill("10");
    await page.locator('#invoice input[name="custom"]').press("Tab");
    await page.waitForFunction(()=>document.querySelector("#qr-out a")?.href.endsWith("ina=10"));
    await page.locator('[data-invoice="0"]').click(); await page.locator("#qr-out img").waitFor();
    await check("receive-qr");
    await page.getByRole("button",{name:"📷 紙カードを読み取る（カメラ起動）",exact:true}).click();
    const scan=page.getByRole("dialog"); await scan.waitFor();
    assert.match(await scan.innerText(),/本人のiineカード/);
    assert.equal(await scan.locator('input[type="file"][accept="image/*"]').count(),1);
    assert.ok(await scan.getByRole("button",{name:"カメラを開く",exact:true}).isVisible());
    await check("paper-camera"); await page.keyboard.press("Escape");
    await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[1].group,store:stores[1].to}));
    await page.locator("[data-tap]").waitFor();
    assert.equal(await page.locator("#screen h1").innerText(),"iineを贈る");
    assert.equal(await page.locator("[data-minus]").evaluate(el=>getComputedStyle(el).touchAction),"manipulation");
    assert.equal(await page.locator("[data-tap]").evaluate(el=>getComputedStyle(el).touchAction),"manipulation");
    const send=page.locator('#ina button[type="submit"]');
    assert.equal(await send.isDisabled(),true);
    for (let n=1;n<=10;n++) {
      await page.locator("[data-tap]").click();
      assert.equal(await page.locator("[data-count]").innerText(),String(n));
      if ([1,3,5,10].includes(n)) {
        const emoji={1:"👍",3:"✨",5:"💖",10:"🌾"}[n];
        assert.equal(await page.locator("[data-emoji]").innerText(),emoji);
        assert.equal(await page.locator('#ina input[name="reaction"]').inputValue(),emoji);
        assert.equal(await page.locator(".charge-dots .selected").count(),n);
        await check("send-"+n);
      }
    }
    await page.locator("[data-tap]").click(); assert.equal(await page.locator("[data-count]").innerText(),"10");
    await send.click(); await page.getByRole("dialog").waitFor();
    assert.match(await page.getByRole("dialog").innerText(),/公開する絵文字：🌾/);
    await page.keyboard.press("Escape");
    await page.locator("[data-minus]").click(); assert.equal(await page.locator("[data-count]").innerText(),"9");
    await page.locator("[data-reset]").click(); assert.equal(await send.isDisabled(),true);
    await page.locator("[data-sound]").click();
    const preference=await page.evaluate(()=>localStorage.getItem("wara.iine.sound"));
    await page.reload(); await page.locator("[data-sound]").waitFor();
    assert.equal(await page.locator("[data-sound]").getAttribute("aria-pressed"),String(preference !== "off"));
    await page.goto(origin+"/support/"); await page.getByRole("heading",{name:"毎日 0:00（JST）にリセット",exact:true}).waitFor(); await check("guide");
    console.log(`${width}px ${colorScheme}: home, lists, QR, paper camera, 1/3/5/10 tiers, reset, mute, guide passed`);
  }
  // Legacy QR presets and an environment without audio/haptics still work.
  await page.addInitScript(()=>{
    window.AudioContext=undefined; window.webkitAudioContext=undefined;
    Object.defineProperty(navigator,"vibrate",{value:()=>{throw Error("unsupported");},configurable:true});
  });
  for(const param of ["ina","kusa"]) {
    await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[1].group,store:stores[1].to,[param]:"3"}));
    await page.locator("[data-tap]").waitFor(); assert.equal(await page.locator("[data-count]").innerText(),"3");
    await page.locator("[data-tap]").click(); assert.equal(await page.locator("[data-count]").innerText(),"4");
  }
  assert.deepEqual(errors,[]);
  console.log("390px: custom dialogs, live receipt/toast/history, QR cleanup passed");
  console.log("390px: profile edit, market, pay/receive lists and direct register link passed");
} finally { await browser.close(); }
