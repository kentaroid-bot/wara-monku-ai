// After npm run build, run with Playwright installed: node tests/shop-directory.browser.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import bs58 from "bs58";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import manifest from "../deployments/devnet.json" with {type:"json"};
import { mintFor } from "../shared/protocol.mjs";
import { groupCreatedKey } from "../mainstream/storage-keys.mjs";
import { DEVNET_GENESIS } from "../app/protocol.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const key = () => String(Keypair.generate().publicKey);
const who = key(), admin = key(), origin = "https://wara.test";
const groups = ["所属中","開設済み","自由参加","申請中","川辺の市場"].map((name,i) => ({
  tag:31,id:i === 4 ? "4SuDmQR72DnjC5GZ78oDk7u4G2w5edNFuVGKFRfEZsLU" : key(),
  name,category:"地域",visibility:"public",owner:i === 1 || i === 4 ? who : admin,mode:i === 1 || i === 3 ? 2 : 0,
}));
const stores = groups.map((g,i) => ({tag:32,id:key(),group:g.id,name:g.name+"の仲間",to:i === 0 || i === 4 ? who : key()}));
const otherStore = {tag:32,id:key(),group:groups[0].id,name:"花屋",to:key()};
stores.push(otherStore);
const privateGroup = {tag:31,id:key(),name:"仲間の集まり",category:"家族・友人",visibility:"private",owner:admin,mode:1,invite:admin,sealed:"test",joined:true,unlocked:true};
groups.push(privateGroup);
const memberRows = groups.slice(0,3).flatMap((g,i)=>Array.from({length:i === 0 ? 2 : 3-i},()=>({tag:33,id:key(),group:g.id,to:key(),status:2})));
const rows = [...groups,...stores,...memberRows,...[0,3].map(i=>({tag:33,id:key(),to:who,group:groups[i].id,status:i === 0 ? 2 : 1}))];
let profile = {shop:stores[0].id,title:"パン屋",caption:"手ごね",icon:"🥐",is_test:true,revision:1};
let paid = false, signatureReads = 0;
const paidSignature = bs58.encode(Buffer.alloc(64, 9));
const paymentData = Buffer.alloc(25); paymentData[0] = 14; paymentData.writeBigUInt64LE(3n, 1);
const chainRows = rows.map(row => {
  const keys = row.tag === 31 ? [row.owner] : [row.group, row.to];
  const data = Buffer.concat([Buffer.from([row.tag]), ...keys.map(k => new PublicKey(k).toBuffer()),
    row.tag === 31 ? Buffer.concat([Buffer.from([row.mode]), SystemProgram.programId.toBuffer(), Buffer.from(JSON.stringify(row.visibility === "private" ? {visibility:"private",sealed:row.sealed} : {name:row.name,description:"",category:row.category}))]) :
    row.tag === 32 ? Buffer.from(row.name) : Buffer.from([row.status])]);
  return {pubkey:row.id,account:{owner:manifest.program,data:[data.toString("base64"),"base64"],lamports:1,executable:false,rentEpoch:0}};
});
const browser = await chromium.launch({executablePath:process.env.CHROME_BIN});
try {
 for (const width of [320,390,1024]) for (const colorScheme of ["light","dark"]) {
  profile = {...profile,title:"パン屋",caption:"手ごね",icon:undefined,revision:1}; paid=false; signatureReads=0;
  const page = await browser.newPage({viewport:{width,height:844},colorScheme,reducedMotion:"no-preference"});
  page.setDefaultTimeout(15000);
  const errors=[];
  let profileUnavailable=false;
  let ownerCertified=false, pendingRequests=[];
  let supplyReads=0, creationReads=0;
  let supplyValues=[10,20,40,30];
  const screenshots = process.env.SCREENSHOT_DIR || process.env.IINE_SCREENSHOT_DIR;
  if (screenshots) await (await import("node:fs/promises")).mkdir(screenshots,{recursive:true});
  const captureDirectory = async name => {
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} overflow at ${width}`);
    assert.equal(await page.locator("#screen [style]").count(),0);
    if(screenshots) await page.screenshot({path:resolve(screenshots,`${width}-${colorScheme}-${name}.png`),fullPage:true});
  };
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
      if (method === "getMultipleAccounts" && params[0].every(address=>groups.some(g=>String(mintFor(manifest.program,g.id))===address))) {
        supplyReads++;
        await new Promise(r=>setTimeout(r,120));
        return route.fulfill({headers:cors,json:{id,jsonrpc:"2.0",result:{context:{slot:1},value:params[0].map(address=>{
          const i=groups.findIndex(g=>String(mintFor(manifest.program,g.id))===address);
          const data=Buffer.alloc(82); data.writeBigUInt64LE(BigInt(supplyValues[i] || 0),36);
          return {...clock,owner:String(TOKEN_PROGRAM_ID),data:[data.toString("base64"),"base64"]};
        })}}});
      }
      if (method === "getSignaturesForAddress" && params[1]?.limit===1000) {
        creationReads++;
        const i=groups.findIndex(g=>g.id===params[0]);
        assert.ok(i>=0 && groups[i].visibility!=="private");
        await new Promise(r=>setTimeout(r,80));
        return route.fulfill({headers:cors,json:{id,jsonrpc:"2.0",result:[{signature:paidSignature,slot:[100,400,300,200][i],blockTime:[100,400,300,200][i],err:null,memo:null,confirmationStatus:"confirmed"}]}});
      }
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
    if (url.pathname === "/api/member/community-profiles") return route.fulfill({json:{groups:[privateGroup]}});
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
    if (url.pathname === "/api/member/shop-profiles") return route.fulfill({json:{profiles:profileUnavailable ? null : [profile]}});
    if (url.pathname === "/api/v3/shop-requests") {
      assert.equal(req.method(),"GET");
      const group = url.searchParams.get("group");
      return route.fulfill({json:{
        certified:group === groups[0].id || (group === groups[1].id && ownerCertified),
        requests:group === groups[1].id ? pendingRequests : [],next:null,
      }});
    }
    if (url.pathname === "/api/auth/status") return route.fulfill({headers:{"X-Wara-Auth":"1"},json:{mode:"trial",version:3}});
    if (url.pathname === "/api/member/session") return route.fulfill({json:{profile:{address:who,type:"phantom",managed:true}}});
    if (url.pathname.startsWith("/api/")) return route.fulfill({json:{}});
    return route.fulfill({path:resolve("dist","."+(url.pathname.endsWith("/") ? url.pathname+"index.html" : url.pathname))});
  });
  await page.goto(origin+"/shop/?mode=receive");
  await page.locator("[data-receive-menu]").click();
  await page.getByText("⚙️ 受け取り窓口情報を編集").click();
  assert.equal(await page.locator("#edit-shop input[type=checkbox]").count(),0);
  assert.equal(await page.getByText("テスト受け取り窓口",{exact:true}).count(),0);
  const iconSelect = page.locator('#edit-shop select[name="icon"]');
  assert.equal(await iconSelect.inputValue(),"","unset icon initially selects None");
  assert.equal(await iconSelect.locator("option").first().textContent(),"なし");
  assert.equal(await iconSelect.locator("option").first().getAttribute("value"),"");
  await iconSelect.selectOption({label:"なし"});
  const caption = "あ".repeat(140);
  await page.locator('#edit-shop input[name="caption"]').fill(caption);
  await captureDirectory("receive-edit-none");
  await page.getByRole("button",{name:"受け取り窓口情報を保存"}).click();
  await page.waitForFunction(caption=>document.querySelector(".recipient-heading .shop-caption")?.textContent===caption,caption);
  assert.equal(profile.title,"パン屋"); assert.equal(profile.icon,""); assert.equal(profile.caption,caption);
  const bareTitle = () => page.locator(".recipient-heading h2").evaluate(el=>[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join(""));
  assert.equal(await bareTitle(),"パン屋","saved title has no leading or trailing space");
  await page.reload();
  await page.waitForFunction(caption=>document.querySelector(".recipient-heading .shop-caption")?.textContent===caption,caption);
  await page.locator("[data-receive-menu]").click();
  await page.getByText("⚙️ 受け取り窓口情報を編集").click();
  assert.equal(await iconSelect.inputValue(),"","empty icon survives reload and deferred enhancement");
  assert.equal(await page.locator('#edit-shop input[name="caption"]').inputValue(),caption);
  assert.equal(await bareTitle(),"パン屋","deferred title enhancement adds no space");
  await captureDirectory("receive-edit-none-reloaded");
  await iconSelect.selectOption("🦊");
  await page.locator('#edit-shop input[name="caption"]').fill("手ごね");
  await page.getByRole("button",{name:"受け取り窓口情報を保存"}).click();
  await page.getByRole("heading",{name:"🦊 パン屋"}).waitFor();
  await page.goto(origin+"/communities/");
  await page.locator("[data-public-sort]").waitFor();
  assert.equal(await page.locator("#screen h1").innerText(),"コミュニティ");
  assert.equal(await page.locator(".page-head .page-action").getAttribute("href"),"/communities/new/");
  assert.deepEqual(await page.locator(".community-directory h2").allTextContents(),["参加済みのコミュニティ","公開コミュニティ"]);
  const joinedSection=page.locator("[data-joined-groups]"), publicSection=page.locator("[data-public-groups]");
  assert.deepEqual(await joinedSection.locator("strong").allTextContents(),["所属中","開設済み","仲間の集まり"]);
  assert.deepEqual(await joinedSection.locator(".market-meta").allTextContents(),["地域","地域","🔒 家族・友人"]);
  assert.equal(await joinedSection.locator(".joined-badge, .unjoined-badge").count(),0);
  assert.doesNotMatch(await joinedSection.innerText(),/参加中|承認制|招待コード/);
  assert.equal(await page.locator(".community-directory .shop-row").count(),0);
  assert.equal(await page.getByRole("link",{name:/🦊 パン屋/}).count(),0);
  const publicNames=()=>publicSection.locator("strong").allTextContents();
  assert.deepEqual(await publicNames(),["所属中","開設済み","自由参加","申請中"]);
  assert.deepEqual(await publicSection.locator(".market-meta").allTextContents(),["地域","地域","地域 · 自由参加","地域 · 承認制"]);
  assert.deepEqual(await publicSection.locator(".joined-badge, .unjoined-badge").allTextContents(),["参加中","参加中","未参加","申請中"]);
  for(const name of ["所属中","開設済み"]) assert.equal(await joinedSection.getByRole("link",{name,exact:true}).count(),1);
  assert.equal(supplyReads,0); assert.equal(creationReads,0);
  assert.ok(await page.locator(".community-directory .market-heading").evaluateAll(rows=>rows.every(row=>{
    const link=row.querySelector("a").getBoundingClientRect(), meta=row.querySelector(".market-meta").getBoundingClientRect();
    return link.height>=44 && link.width>=44 && meta.top<link.bottom && meta.bottom>link.top;
  })),"single-row communities have 44px link targets");
  for(const selector of [".page-action","[data-public-sort]"]) assert.ok((await page.locator(selector).boundingBox()).height>=44);
  await captureDirectory("communities-members");
  const sort=page.locator("[data-public-sort]");
  assert.deepEqual(await sort.locator("option").allTextContents(),["参加人数順","新着順","総WARA順"]);
  await sort.selectOption("wara");
  await sort.selectOption("members");
  await sort.selectOption("wara");
  await page.locator('[data-public-rows][aria-busy="false"]').waitFor();
  assert.deepEqual(await publicNames(),["自由参加","申請中","開設済み","所属中"]);
  assert.equal(supplyReads,1,"rapid toggles share the mint read");
  await captureDirectory("communities-wara");
  supplyValues=[50,20,40,30];
  await page.getByRole("button",{name:"更新",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-public-rows][aria-busy="false"] strong')?.textContent === "所属中");
  assert.equal(supplyReads,2,"refresh fetches current supplies");
  assert.deepEqual(await publicNames(),["所属中","自由参加","申請中","開設済み"]);
  await sort.selectOption("members"); await sort.selectOption("wara");
  await page.locator('[data-public-rows][aria-busy="false"]').waitFor();
  assert.equal(supplyReads,2,"sort changes reuse supplies within the refreshed state");
  await sort.selectOption("new");
  await page.locator('[data-public-rows][aria-busy="false"]').waitFor();
  assert.deepEqual(await publicNames(),["開設済み","自由参加","申請中","所属中"]);
  assert.equal(creationReads,4);
  assert.equal(await page.evaluate(key=>Object.keys(JSON.parse(localStorage.getItem(key))).length,groupCreatedKey(manifest.program)),4);
  await captureDirectory("communities-new");
  await sort.selectOption("members"); await sort.selectOption("new");
  await page.locator('[data-public-rows][aria-busy="false"]').waitFor();
  assert.equal(creationReads,4);
  await page.goto(origin+"/communities/new/");
  await page.locator("#create").waitFor();
  assert.deepEqual(await page.locator('#create select[name="mode"] option').allTextContents(),["招待コード","承認制"]);
  const expectedCategories=["地域","学校","職場","サークル","イベント","お店・施設","家族・友人","オンライン","その他"];
  assert.deepEqual(await page.locator('#create select[name="category"] option').allTextContents(),expectedCategories);
  await captureDirectory("community-create");
  await page.goto(origin+"/communities/?id="+groups[1].id);
  await page.locator("#policy").waitFor();
  assert.equal(await page.locator(".page-action").count(),0);
  assert.deepEqual(await page.locator('#policy select[name="mode"] option').allTextContents(),["招待コード","承認制"]);
  assert.deepEqual(await page.locator('#policy select[name="category"] option').allTextContents(),expectedCategories);
  await captureDirectory("community-policy");
  await page.goto(origin+"/communities/?id="+groups[4].id);
  await page.locator("#policy").waitFor();
  assert.deepEqual(await page.locator('#policy select[name="mode"] option').allTextContents(),["自由参加","招待コード","承認制"]);
  assert.equal(await page.locator('#policy select[name="mode"]').inputValue(),"0");
  // A navigation during a pending sort must leave the new form intact.
  await page.goto(origin+"/communities/"); await page.locator("[data-public-sort]").waitFor();
  await page.locator("[data-public-sort]").selectOption("wara");
  await page.locator(".page-action").click(); await page.locator("#create").waitFor();
  assert.equal(await page.locator("[data-public-rows]").count(),0);
  await page.goto(origin+"/shop/");
  await page.getByRole("link",{name:/開設済みの仲間/}).waitFor();
  assert.equal(await page.locator("#screen h1").innerText(),"iineを贈る");
  const listedStores = () => page.locator('a[href^="/shop/?group="]').evaluateAll(links=>links.map(link=>new URL(link.href).searchParams.get("store")));
  // Own stores stay out of recipient choices; only other recipients in joined communities appear.
  assert.deepEqual(await listedStores(),[stores[1].to,otherStore.to]);
  assert.equal(await page.getByRole("link",{name:/🦊 パン屋/}).count(),0);
  await page.goto(origin+"/shop/?mode=receive");
  await page.locator("#qr-out img").waitFor();
  assert.equal(await page.locator("#screen h1").innerText(),"受け取る");
  // A non-member can still follow a public register link and see the existing invitation to join.
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[2].group,store:stores[2].to}));
  await page.getByRole("link",{name:"コミュニティに参加して贈る"}).waitFor();
  // Three confirmations use native dialog controls; no browser confirm prompt.
  page.on("dialog", () => assert.fail("unexpected browser confirm"));
  await page.goto(origin+"/shop/?"+new URLSearchParams({group:stores[1].group,store:stores[1].to}));
  await page.locator("[data-tap]").click();
  const feedback=page.locator("#ina .payment-memo");
  await page.locator("[data-open-memo]").click();
  const smile=feedback.getByRole("button",{name:"😊"});
  await smile.click(); assert.equal(await smile.getAttribute("aria-pressed"),"true");
  await smile.click(); assert.equal(await smile.getAttribute("aria-pressed"),"false");
  await feedback.getByRole("button",{name:"助かりました"}).click();
  assert.equal(await feedback.getByLabel("ひとこと").inputValue(),"助かりました");
  await feedback.getByLabel("ひとこと").fill("また来ます、ありがとう");
  await page.keyboard.press("Escape");
  await page.locator("#ina").getByRole("button",{name:"贈る",exact:true}).click();
  await page.getByRole("dialog").waitFor();
  if (!process.env.SCREENSHOT_FILTER) await page.screenshot({path:"/tmp/wara-phase2-confirm.png"});
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
  await page.locator("#ina").getByRole("button",{name:"贈る",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"贈る",exact:true}).click();
  const recheck=page.getByRole("button",{name:"Phantomの接続を確認する"});
  await recheck.waitFor();
  assert.equal(new URL(page.url()).pathname,"/shop/");
  assert.ok((await page.locator("#notice").innerText()).includes(who.slice(-6)));
  await page.evaluate(()=>window.selectRegistered());
  await recheck.click();
  await page.getByText(/登録した財布に接続しました/).waitFor();
  assert.equal(await page.getByRole("dialog").count(),0);
  await page.locator("[data-open-wara]").click();
  await page.locator('#wara input[name="amount"]').fill("10");
  await page.locator("#wara").getByRole("button",{name:"WARAを贈る"}).click();
  await page.locator(".confirm-dialog").getByRole("button",{name:"キャンセル"}).click();
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
  if (!process.env.SCREENSHOT_FILTER) await page.screenshot({path:"/tmp/wara-phase2-register.png"});
  paid = true;
  await page.locator("#crystal-toast").filter({hasText:"+300"}).waitFor({timeout:15000});
  await page.locator("[data-receive-menu]").click();
  await page.locator(".story").filter({hasText:"3 iine"}).waitFor();
  await page.locator(".story").getByText("ひとこと「また来ます <3」").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#qr-out img").waitFor();
  await page.locator("#qr-out").evaluate(el=>el.remove());
  const afterPayment = signatureReads;
  await page.waitForTimeout(5500);
  assert.equal(signatureReads,afterPayment,"payment stops the register watcher");
  await page.locator(".invoice-custom summary").click();
  await page.locator('#invoice button[type="submit"]').click();
  await page.locator("#qr-out img").waitFor();
  await page.locator("#qr-out").evaluate(el=>el.remove());
  const afterRemoval = signatureReads;
  await page.waitForTimeout(5500);
  assert.equal(signatureReads,afterRemoval,"removing only the QR stops its watcher");
  {
    await page.setViewportSize({width,height:844}); await page.emulateMedia({colorScheme});
    const check = async name => {
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width}`);
      if (screenshots && (!process.env.SCREENSHOT_FILTER || new RegExp(process.env.SCREENSHOT_FILTER).test(`${width}-${colorScheme}-${name}`))) await page.screenshot({path:resolve(screenshots,`${width}-${colorScheme}-${name}.png`),fullPage:true});
    };
    await page.goto(origin+"/"); await page.locator(".home-receipts").waitFor();
    assert.equal(await page.locator(".quick-actions").count(),0);
    assert.equal(await page.locator(".home-send").getAttribute("href"),"/shop/");
    await page.evaluate(()=>{localStorage.removeItem("wara.v03.warmth.last");dispatchEvent(new Event("pageshow"));});
    assert.ok(await page.evaluate(()=>{
      const a=document.querySelector(".home-history").getBoundingClientRect(), b=document.querySelector(".home-receive img").getBoundingClientRect();
      return a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom;
    }),"home history does not cover the receiving character");
    const motion = await page.evaluate(() => {
      const box=s=>document.querySelector(s).getBoundingClientRect();
      const clear=(a,b)=>a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom;
      const selectors=[".home-sender",".home-heart",".home-receive img"];
      const frame=box(".frame"), css=getComputedStyle(document.querySelector(".frame"));
      const left=frame.left+parseFloat(css.borderLeftWidth), right=frame.right-parseFloat(css.borderRightWidth);
      const results=[];
      for (const celebrate of [false,true]) {
        document.documentElement.classList.toggle("has-send-fx",celebrate);
        const animations=selectors.map(s=>document.querySelector(s).getAnimations()[0]);
        if (animations.some(a=>!a)) throw Error("missing home animation");
        animations.forEach(a=>{a.pause();a.currentTime=0;});
        // Sweep each complete cycle independently, including all keyframe peaks.
        for (const [i,a] of animations.entries()) {
          const tops=[];
          for (let step=0;step<=40;step++) {
            a.currentTime=Number(a.effect.getTiming().duration)*step/40;
            const sender=box(selectors[0]), heart=box(selectors[1]), receiver=box(selectors[2]);
            if (document.documentElement.scrollWidth>innerWidth ||
                !clear(box(".home-send-label"),sender) || !clear(box(".home-send-label"),heart) ||
                !clear(box(".home-history"),receiver) || !clear(box(".home-history"),heart) ||
                !clear(box("nav"),receiver) ||
                Math.abs(sender.left-left)>.01 || Math.abs(receiver.right-right)>.01)
              throw Error(`home motion layout: ${celebrate}/${selectors[i]}/${step}`);
            tops.push(box(selectors[i]).top);
          }
          results.push({celebrate,selector:selectors[i],duration:a.effect.getTiming().duration,topTravel:Math.max(...tops)-Math.min(...tops),samples:41});
          a.currentTime=0;
        }
        animations.forEach(a=>a.play());
      }
      document.documentElement.classList.remove("has-send-fx");
      return results;
    });
    for (const sample of motion) assert.ok(sample.topTravel>=6,`visible movement: ${JSON.stringify(sample)}`);
    console.log(`PASS home motion ${width}px ${colorScheme}: ${JSON.stringify(motion)}`);
    // Reapply the media query after the deterministic sweep and verify static mode too.
    await page.emulateMedia({reducedMotion:"reduce"});
    for (const selector of [".home-sender",".home-heart",".home-receive img"])
      assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).animationName),"none");
    await check("home-reduced");
    await page.emulateMedia({reducedMotion:"no-preference"});
    await check("home");
    assert.equal(await page.locator("footer").count(),0);
    assert.equal(await page.getByRole("button",{name:"更新",exact:true}).count(),0);
    assert.equal(await page.getByRole("button",{name:"履歴を更新",exact:true}).count(),0);
    assert.ok(await page.locator(".home-receive-label").isVisible());
    assert.equal(await page.locator(".home-receive-label").innerText(),"うけとる");
    assert.equal(await page.locator(".home-send-label").innerText(),"おくる");
    assert.ok(await page.evaluate(() => {
      const box=s=>document.querySelector(s).getBoundingClientRect(), label=box(".home-send-label");
      return [".top-counters",".theme",".home-sender"].every(s=>{
        const b=box(s); return label.right<=b.left || label.left>=b.right || label.bottom<=b.top || label.top>=b.bottom;
      }) && box(".home-receive-label").bottom<box("nav").top;
    }),"home labels do not overlap counters, theme, artwork or navigation");
    assert.equal(await page.locator("details#origins").count(),0);
    await page.locator(".top-counters a").click();
    const originsDialog = page.getByRole("dialog",{name:"WARAの発行元内訳"});
    assert.ok(await originsDialog.locator("#origins").isVisible());
    await originsDialog.getByRole("button",{name:"状態を更新",exact:true}).click();
    await page.locator(".home-receipts").waitFor();
    assert.equal(await page.getByRole("dialog").count(),0);
    assert.deepEqual(await page.locator(".home-send").evaluate(el=>{
      document.documentElement.style.setProperty("--warmth","0"); const cool=getComputedStyle(el,"::before").opacity;
      document.documentElement.style.setProperty("--warmth","1"); return [cool,getComputedStyle(el,"::before").opacity];
    }),["0","1"]);
    await check("home-warm");
    await page.locator(".home-send").click(); await page.locator(".recipient-row").first().waitFor();
    assert.equal(await page.getByRole("dialog").getAttribute("aria-label"),"相手を選ぶ");
    assert.match(await page.locator(".recipient-row").first().innerText(),/開設済み/); await check("recipients");
    await check("picker");
    await page.goto(origin+"/shop/"); await page.locator(".recipient-row").first().waitFor(); await check("recipient-list");
    await page.goto(origin+"/shop/?mode=receive"); await page.locator("#qr-out img").waitFor();
    assert.equal(await page.locator("#screen h1").innerText(),"受け取る");
    assert.ok(!new URL(await page.locator("#qr-out a").getAttribute("href")).searchParams.has("ina"));
    for (const n of [1,3,5]) {
      await page.locator(`[data-invoice="${n}"]`).click();
      await page.waitForFunction(n=>document.querySelector("#qr-out a")?.href.endsWith("ina="+n),n);
    }
    await page.locator(".invoice-custom summary").click();
    await page.locator('#invoice input[name="custom"]').fill("10");
    await page.locator('#invoice input[name="custom"]').press("Tab");
    await page.waitForFunction(()=>document.querySelector("#qr-out a")?.href.endsWith("ina=10"));
    await page.locator('[data-invoice="0"]').click(); await page.locator("#qr-out img").waitFor();
    await page.locator(".invoice-custom summary").click();
    await check("receive-qr");
    await page.locator("[data-receive-menu]").click();
    await page.getByRole("button",{name:"📷 紙カードを読み取る（カメラ起動）",exact:true}).click();
    const scan=page.getByRole("dialog").last(); await scan.waitFor();
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
    const scales=[];
    const checkHeart=async count=>{
      // Let the size transition finish before measuring the artwork.
      await page.waitForTimeout(250);
      scales.push(await page.locator(".iine-stage").evaluate(el=>Number(getComputedStyle(el).getPropertyValue("--heart-scale"))));
      assert.ok(Math.abs(scales.at(-1)-(.45+count*.06))<.0001);
      assert.ok(await page.evaluate(()=>{
        const box=s=>document.querySelector(s).getBoundingClientRect();
        const clear=(a,b)=>a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom;
        return [".tap-button",".iine-heart"].every(s=>[".send-dock",".charge-dots",".receive-mascot"].every(t=>clear(box(s),box(t)))) && box(".send-dock").right<=box(".receive-mascot").left;
      }),`heart and tap target clear the dock, dots and mascot at ${count}`);
      const layout=await page.evaluate(()=>{
        const box=s=>document.querySelector(s).getBoundingClientRect();
        const frame=box(".frame"), style=getComputedStyle(document.querySelector(".frame"));
        const sender=box(".send-mascot"), receiver=box(".receive-mascot"), dock=box(".send-dock");
        const clear=(a,b)=>a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom;
        return {
          frameLeft:frame.left+parseFloat(style.borderLeftWidth), frameRight:frame.right-parseFloat(style.borderRightWidth),
          senderLeft:sender.left, receiverRight:receiver.right, dockRight:dock.right, receiverLeft:receiver.left,
          heartBottom:box(".iine-heart").bottom, receiverTop:receiver.top, receiverBottom:receiver.bottom,
          toolsTop:box(".gift-tools").top, navTop:box("nav").top,
          artworkClear:[sender,receiver].every(a=>[".send-dock",".gift-tools","nav"].every(s=>clear(a,box(s)))),
          scrollWidth:document.documentElement.scrollWidth, innerWidth,
          imageStyles:[".send-mascot",".receive-mascot"].map(s=>{
            const css=getComputedStyle(document.querySelector(s)); return [css.objectFit,css.objectPosition];
          }),
        };
      });
      const context=`${width}px ${colorScheme} send-${count}`;
      assert.ok(Math.abs(layout.senderLeft-layout.frameLeft)<.01,`sender meets the inner frame left edge: ${context}`);
      assert.ok(Math.abs(layout.receiverRight-layout.frameRight)<.01,`receiver meets the inner frame right edge: ${context}`);
      assert.deepEqual(layout.imageStyles,[["contain","0% 0%"],["contain","100% 100%"]],`artwork aligns within its image box: ${context}`);
      assert.ok(layout.dockRight<=layout.receiverLeft,`dock clears the receiver: ${context}`);
      assert.ok(layout.artworkClear,`mascots clear the dock, gift tools and navigation: ${context}`);
      assert.ok(layout.scrollWidth<=layout.innerWidth,`no horizontal overflow: ${context}`);
      console.log(`PASS send layout ${context}: ${JSON.stringify(layout)}`);
    };
    const checkSendMotion=async(mode,count)=>{
      const samples=await page.evaluate(({mode,count})=>{
        const stage=document.querySelector(".iine-stage");
        stage.classList.toggle("sending",mode==="sending");
        if(mode==="tap") document.querySelector("[data-tap]").click();
        const selectors=[".send-mascot",".receive-mascot",".tap-button",".iine-heart"];
        const elements=selectors.map(s=>document.querySelector(s));
        const animations=elements.flatMap(el=>el.getAnimations());
        animations.forEach(a=>{a.pause();a.currentTime=0;});
        const box=s=>document.querySelector(s).getBoundingClientRect();
        const clear=(a,b)=>a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom;
        const frame=box(".frame"), css=getComputedStyle(document.querySelector(".frame"));
        const left=frame.left+parseFloat(css.borderLeftWidth), right=frame.right-parseFloat(css.borderRightWidth);
        const verify=phase=>{
          const sender=box(selectors[0]),receiver=box(selectors[1]);
          const checks={
            senderEdge:Math.abs(sender.left-left)<.01,receiverEdge:Math.abs(receiver.right-right)<.01,
            dock:box(".send-dock").right<=receiver.left,
            tap:clear(box(".tap-button"),receiver),heart:clear(box(".iine-heart"),receiver),
            artwork:[sender,receiver].every(a=>[".send-dock",".gift-tools","nav"].every(s=>clear(a,box(s)))),
            overflow:document.documentElement.scrollWidth<=innerWidth,
          };
          if(Object.values(checks).some(ok=>!ok)) throw Error(`send motion ${mode}/${count}/${phase}: ${JSON.stringify(checks)}`);
        };
        const results=[];
        const sweep=(animation,selector)=>{
          const tops=[],transforms=[];
          for(let step=0;step<=40;step++) {
            if(mode==="tap") {
              // One real clock: the heart pulse, size transition and both reactions overlap.
              for(const a of animations) a.currentTime=Math.min(320*step/40,Number(a.effect.getTiming().duration));
            } else animation.currentTime=Number(animation.effect.getTiming().duration)*step/40;
            verify(`${selector}/${step}`);
            const el=document.querySelector(selector);
            tops.push(el.getBoundingClientRect().top);transforms.push(getComputedStyle(el).transform);
          }
          results.push({mode,count,selector,topTravel:Math.max(...tops)-Math.min(...tops),transforms:new Set(transforms).size,samples:41});
          animations.forEach(a=>a.currentTime=0);
        };
        for(const [i,el] of elements.entries()) {
          const animation=el.getAnimations().find(a=>mode==="tap" ? !(a instanceof CSSAnimation) : a instanceof CSSAnimation);
          if(i<2 && !animation) throw Error(`missing ${mode} motion: ${selectors[i]}`);
          if(animation) sweep(animation,selectors[i]);
        }
        if(mode==="tap") {
          // A tap can arrive at any point in the independent heart wobble.
          const wobble=elements[2].getAnimations().find(a=>a instanceof CSSAnimation);
          for(const phase of [.44,.5,.58]) for(let step=0;step<=40;step++) {
            for(const a of animations) if(!(a instanceof CSSAnimation))
              a.currentTime=Math.min(320*step/40,Number(a.effect.getTiming().duration));
            wobble.currentTime=Number(wobble.effect.getTiming().duration)*phase;
            verify(`wobble-${phase}/${step}`);
          }
        }
        // Keep a deterministic peak for screenshots; restore normal playback below.
        for(const a of animations) a.currentTime=mode==="tap" ? Math.min(112,Number(a.effect.getTiming().duration)) : Number(a.effect.getTiming().duration)*.35;
        verify("screenshot");
        return results;
      },{mode,count});
      for(const sample of samples.filter(s=>s.selector.endsWith("mascot"))) {
        assert.ok(sample.topTravel>5,`visible motion ${width}/${colorScheme}: ${JSON.stringify(sample)}`);
        assert.ok(sample.transforms>20,`varying transform: ${JSON.stringify(sample)}`);
      }
      if(mode==="tap" && count===10) await check("send-tap");
      if(mode==="sending" && count===10) await check("sending");
      await page.evaluate(()=>{
        for(const el of document.querySelectorAll(".iine-stage, .iine-stage *")) for(const a of el.getAnimations()) {
          if(a instanceof CSSAnimation) a.play(); else a.finish();
        }
        document.querySelector(".iine-stage").classList.remove("sending");
      });
      console.log(`PASS send motion ${width}px ${colorScheme}: ${JSON.stringify(samples)}`);
    };
    assert.equal(await send.isDisabled(),true); await checkHeart(0); await check("send-0");
    await checkSendMotion("idle",0);
    for (let n=1;n<=10;n++) {
      await checkSendMotion("tap",n);
      assert.equal(await page.locator("[data-count]").innerText(),String(n));
      await checkSendMotion("idle",n);
      await checkSendMotion("sending",n);
      if ([1,3,5,10].includes(n)) {
        const emoji={1:"👍",3:"✨",5:"💖",10:"🌾"}[n];
        assert.equal(await page.locator("[data-emoji]").innerText(),emoji);
        assert.equal(await page.locator('#ina input[name="reaction"]').inputValue(),emoji);
        assert.equal(await page.locator(".charge-dots .selected").count(),n);
        const mascot=await page.locator(".receive-mascot").boundingBox();
        const dock=await page.locator(".send-dock").boundingBox();
        assert.ok(dock.x+dock.width<=mascot.x,"gift controls do not cover the receiving character");
        assert.equal(await send.locator("span").count(),0,"send stamp contains only its number");
        if ([5,10].includes(n)) await checkHeart(n);
        await check("send-"+n);
        if(n===5) {
          await send.click(); await page.locator(".confirm-dialog").waitFor();
          await check("send-confirm-5"); await page.keyboard.press("Escape");
          assert.equal(new URL(page.url()).pathname,"/shop/");
        }
      }
    }
    assert.ok(scales[0]<.5 && scales[0]<scales[1] && scales[1]<scales[2],"heart grows from 0 through 5 to 10 taps");
    await page.emulateMedia({reducedMotion:"reduce"});
    for(const sending of [false,true]) {
      await page.evaluate(sending=>document.querySelector(".iine-stage").classList.toggle("sending",sending),sending);
      assert.deepEqual(await page.locator(".send-mascot, .receive-mascot").evaluateAll(els=>els.map(el=>[el.getAnimations().length,getComputedStyle(el).transform])),[[0,"none"],[0,"none"]]);
    }
    await check("send-reduced");
    await page.evaluate(()=>document.querySelector(".iine-stage").classList.remove("sending"));
    await page.emulateMedia({reducedMotion:"no-preference"});
    const bump=await page.evaluate(()=>{
      document.querySelector("[data-tap]").click();
      const stage=document.querySelector(".iine-stage"), animation=stage.getAnimations()[0];
      if(!animation) throw Error("missing cap bump");
      animation.pause();
      for(let step=0;step<=40;step++) {
        animation.currentTime=180*step/40;
        if(document.documentElement.scrollWidth>innerWidth) throw Error(`cap overflow at ${step}`);
      }
      animation.finish();
      return [...document.querySelectorAll(".send-mascot, .receive-mascot")].every(el=>el.getAnimations().every(a=>a instanceof CSSAnimation));
    });
    assert.ok(bump,"cap retains stage feedback without mascot tap reactions");
    assert.equal(await page.locator("[data-count]").innerText(),"10");
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
    assert.equal(await page.getByRole("link",{name:"旧Devnet検証版"}).getAttribute("href"),"/devnet/");
    assert.equal(await page.getByRole("link",{name:"この仕組みの原案"}).getAttribute("href"),"https://github.com/kentaroid-bot/emergency-straw-protocol");
    await page.goto(origin+"/communities/"); await page.locator(".market-row").first().waitFor(); await check("communities");
    assert.equal(await page.locator(".market-row > .tag-pill").count(),0);
    assert.doesNotMatch(await page.locator(".market-row").first().innerText(),/受け取り窓口 \d+件/);
    assert.ok(await page.locator(".market-heading .market-meta").first().isVisible());
    // Community detail keeps both own and other shops after async profile enhancement.
    await page.goto(origin+"/communities/?id="+groups[0].id);
    const giftCard = page.locator("section.paper-card").filter({has:page.getByRole("heading",{name:"贈る",exact:true})});
    const ownShop = giftCard.locator(`[data-shop-label="${stores[0].id}"]`);
    await ownShop.filter({hasText:"🦊 パン屋"}).waitFor();
    assert.equal(await ownShop.evaluate(el=>el.firstChild.textContent),"🦊 パン屋");
    assert.equal(await ownShop.locator("small").innerText(),"手ごね");
    assert.deepEqual(await giftCard.locator("a.action").evaluateAll(links=>links.map(a=>new URL(a.href).searchParams.get("store"))),[who,otherStore.to]);
    assert.deepEqual(await giftCard.locator("[data-shop-label]").evaluateAll(labels=>labels.map(el=>el.firstChild.textContent)),["🦊 パン屋","花屋"]);
    assert.equal(await giftCard.locator("[data-register-label]").count(),0);
    assert.doesNotMatch(await giftCard.innerText(),/の受け取り窓口/);
    const receive = page.getByRole("link",{name:"このコミュニティで受け取る",exact:true});
    await receive.waitFor();
    assert.equal(await receive.getAttribute("href"),await ownShop.locator("..").getAttribute("href"));
    assert.equal(await page.getByRole("heading",{name:"このコミュニティで受け取り窓口を開く",exact:true}).count(),0);
    assert.ok(await page.getByRole("heading",{name:"提携コミュニティ",exact:true}).isVisible());
    assert.ok(await page.getByText("お互いに提携を承認したコミュニティのWARAを使えます。",{exact:true}).isVisible());
    assert.ok(await page.getByText("提携中のコミュニティはありません。",{exact:true}).isVisible());
    assert.doesNotMatch(await page.locator("#screen").innerText(),/通貨同盟|\/private\/|\/Users\//);
    for (const id of [groups[0].id,stores[0].id,otherStore.id,who,otherStore.to])
      assert.ok(!(await page.locator("#screen").innerText()).includes(id),"detail does not display internal IDs");
    await check("community-certified");
    await ownShop.click();
    await page.locator("#qr-out img").waitFor();
    assert.equal(await page.locator("#screen h1").innerText(),"受け取る");

    await page.goto(origin+"/communities/?id="+groups[1].id);
    const requestsPanel = page.locator("[data-shop-requests]");
    await requestsPanel.getByRole("heading",{name:"このコミュニティで受け取り窓口を開く",exact:true}).waitFor();
    assert.ok(await requestsPanel.locator("form[data-apply]").isVisible());
    assert.ok(await requestsPanel.getByRole("button",{name:"受け取り窓口の開設を申請する",exact:true}).isVisible());
    assert.equal(await receive.count(),0);
    await page.getByText("他のコミュニティへ提携を申請",{exact:true}).click();
    const peerSelect = page.locator('form.treaty select[name="peer"]');
    await peerSelect.waitFor();
    assert.equal(await peerSelect.locator("..").evaluate(el=>el.firstChild.textContent),"申請先のコミュニティ");
    assert.equal(await peerSelect.locator("option").count(),groups.filter(g=>g.visibility!=="private").length-1);
    assert.doesNotMatch(await page.locator("#screen").innerText(),/通貨同盟|他の地域へ提携を申請|申請先の地域|\/private\/|\/Users\//);
    await check("community-uncertified");
    // Pending applicants retain the heading; certified owners retain their queue below the link.
    pendingRequests=[{request_id:"pending-own",merchant:who,title:"手づくりのお店"}];
    await page.reload();
    await requestsPanel.getByText("申請中：手づくりのお店の受け取り窓口（管理者の公認待ち）",{exact:true}).waitFor();
    assert.ok(await requestsPanel.getByRole("heading",{name:"このコミュニティで受け取り窓口を開く",exact:true}).isVisible());
    assert.equal(await requestsPanel.locator("form[data-apply]").count(),0);
    ownerCertified=true;
    pendingRequests=[{request_id:"pending-other",merchant:admin,title:"仲間のお店"}];
    await page.reload();
    await receive.waitFor();
    assert.equal(await requestsPanel.locator("h2").count(),0);
    assert.ok(await requestsPanel.getByRole("heading",{name:"受け取り窓口の開設申請（1件）",exact:true}).isVisible());
    assert.ok(await requestsPanel.getByRole("button",{name:"公認して受け取り窓口を作る",exact:true}).isVisible());
    assert.ok(await requestsPanel.evaluate(el=>Boolean(el.querySelector("a.action").compareDocumentPosition(el.querySelector("h3")) & Node.DOCUMENT_POSITION_FOLLOWING)));
    ownerCertified=false; pendingRequests=[];
    console.log(`PASS community copy ${width}px ${colorScheme}: certified, uncertified, pending, owner queue, self QR, profile enhancement and partnership copy`);
    await page.goto(origin+"/communities/new/"); await page.locator("#create").waitFor(); await check("community-new");
    console.log(`${width}px ${colorScheme}: home, lists, QR, paper camera, 1/3/5/10 tiers, reset, mute, guide passed`);
  }
  // Profile failures remain visible off home, without hiding balance-read errors.
  profileUnavailable=true;
  const profileError="受け取り窓口プロフィールを取得できません。「更新」で再試行できます。";
  for (const path of ["/account/","/communities/?id="+groups[0].id,"/","/user/"]) {
    const response = page.waitForResponse(r=>new URL(r.url()).pathname==="/api/member/shop-profiles");
    await page.goto(origin+path);
    await (await response).finished();
    await page.waitForLoadState("networkidle");
    if (path === "/" || path === "/user/") assert.equal(await page.locator("#notice").innerText(),"");
    else assert.ok((await page.locator("#notice").innerText()).includes(profileError));
  }
  await page.evaluate(sig=>sessionStorage.setItem("wara.ui.sent",JSON.stringify({amount:"300",sig})),paidSignature);
  await page.goto(origin+"/"); await page.waitForLoadState("networkidle");
  assert.match(await page.locator("#notice").innerText(),/贈りました。相手に 300 WARAが届きました。/);
  assert.ok(!(await page.locator("#notice").innerText()).includes(profileError));
  assert.ok(await page.locator('#notice a[href*="explorer.solana.com"]').isVisible());
  profileUnavailable=false;
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
  console.log(`${width}px ${colorScheme}: custom dialogs, live receipt/toast/history, QR cleanup passed`);
  console.log(`${width}px ${colorScheme}: profile edit, market, pay/receive lists and direct register link passed`);
  await page.close();
 }
} finally { await browser.close(); }
