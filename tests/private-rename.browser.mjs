// Run after building: WARA_RENAME_BROWSER=1 node --test tests/gasless.test.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import manifest from "../deployments/devnet.json" with {type:"json"};

export async function checkRenameInBrowsers({runtime,base,rows,rpcRequest,admin,member}) {
  const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({executablePath:process.env.CHROME_BIN});
  try {
    async function open(account) {
      const context = await browser.newContext({viewport:{width:390,height:844}});
      const p = await context.newPage();
      await p.addInitScript(({account,rows,program})=>{
        localStorage.setItem("wara.member",JSON.stringify({...account,profile:{managed:true,type:"phantom",address:account.address},expires:Date.now()+600000}));
        sessionStorage.setItem("wara.v03.policy-directory."+program,JSON.stringify({rows,at:Date.now()}));
      },{account,rows,program:manifest.program});
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
    assert.deepEqual(await participant.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("wara.private."))),[]);
  } finally {await browser.close()}
}
