// Run after building: WARA_RENAME_BROWSER=1 node --test tests/gasless.test.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import manifest from "../deployments/devnet.json" with {type:"json"};

export async function checkRenameInBrowsers({runtime,base,rows,code,rpcRequest,admin,member}) {
  const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({executablePath:process.env.CHROME_BIN});
  try {
    let simulateOutage = false;
    async function open(account, oldInvite = false) {
      const context = await browser.newContext({viewport:{width:390,height:844}});
      const p = await context.newPage();
      await p.addInitScript(({account,rows,program,code})=>{
        localStorage.setItem("wara.member",JSON.stringify({...account,profile:{managed:true,type:"phantom",address:account.address},expires:Date.now()+600000}));
        if (code) localStorage.setItem("wara.private."+account.address+"."+rows[0].id+"."+rows[0].invite,code);
        sessionStorage.setItem("wara.v03.policy-directory."+program,JSON.stringify({rows,at:Date.now()}));
      },{account,rows:oldInvite ? rows.slice(0,1) : rows,code:oldInvite && code,program:manifest.program});
      await p.route("**/*",async route=>{
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== base) {
          const headers = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"*","Access-Control-Allow-Methods":"*"};
          if (req.method()==="OPTIONS") return route.fulfill({status:204,headers});
          const body = req.postDataJSON();
          const result = body.method === "getSignaturesForAddress" ? {id:body.id,jsonrpc:"2.0",result:[]} :
            await (await rpcRequest(new Request(url,{method:"POST",body:req.postData()}))).json();
          return route.fulfill({json:result,headers});
        }
        if (oldInvite && simulateOutage && url.pathname.endsWith("community-profiles")) return route.fulfill({status:503,json:{error:"temporarily unavailable"}});
        if (url.pathname.startsWith("/api/")) {
          const res = await runtime.dispatchFetch(req.url(),{method:req.method(),headers:req.headers(),body:req.postData()??undefined});
          return route.fulfill({status:res.status,body:await res.text(),contentType:"application/json"});
        }
        return route.fulfill({path:resolve("dist","."+(url.pathname.endsWith("/")?url.pathname+"index.html":url.pathname))});
      });
      return p;
    }
    const owner = await open(admin), participant = await open(member);
    await owner.goto(base+"/communities/?id="+rows[0].id);
    await participant.goto(base+"/communities/");
    await participant.getByRole("link",{name:"星の集会",exact:true}).waitFor();
    const form = owner.locator("#private-name");
    await form.getByLabel("コミュニティ名").fill("月夜の集会");
    await form.getByRole("button",{name:"名前を保存"}).click();
    await owner.getByRole("heading",{name:"月夜の集会",exact:true}).waitFor();
    await participant.reload();
    await participant.getByRole("link",{name:"月夜の集会",exact:true}).click();
    await participant.getByRole("heading",{name:"月夜の集会",exact:true}).waitFor();
    assert.equal(await participant.locator("#private-name").count(),0);
    const returning = await open(member,true);
    await returning.goto(base+"/communities/?id="+rows[0].id);
    await returning.getByRole("heading",{name:"月夜の集会",exact:true}).waitFor();
    assert.equal(await returning.locator("#join").count(),0);
    // Fresh server membership overrides an empty local membership list.
    // Now retain the real membership row while simulating a read outage.
    await returning.evaluate(({rows,program})=>sessionStorage.setItem("wara.v03.policy-directory."+program,JSON.stringify({rows,at:Date.now()})),{rows,program:manifest.program});
    simulateOutage = true;
    await returning.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await returning.getByRole("heading",{name:"限定公開コミュニティ（名称未確認）",exact:true}).waitFor();
    simulateOutage = false;
    await returning.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await returning.getByRole("heading",{name:"月夜の集会",exact:true}).waitFor();
    assert.deepEqual(await participant.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("wara.private."))),[]);
  } finally {await browser.close()}
}
