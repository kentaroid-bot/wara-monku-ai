// After npm run build, run with Playwright installed: node tests/shop-directory.browser.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Keypair, SystemProgram } from "@solana/web3.js";
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
      const result = method === "getGenesisHash" ? DEVNET_GENESIS :
        method === "getMultipleAccounts" ? {context:{slot:1},value:params[0].map((_,i)=>i ? null : clock)} : [];
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
  console.log("390px: profile edit, market, pay/receive lists and direct register link passed");
} finally { await browser.close(); }
