import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { transcript, phoneDigest, toBase64 } from "../shared/auth-wire.mjs";

const origin = "https://wara.example";
let runtime, db;
before(async () => {
  const bundle = await build({
    entryPoints: ["worker/index.mjs"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  runtime = new Miniflare({
    enableDevRegistry: false,
    workers: [
      {
        config: {
          name: "wara-auth-tests",
          compatibilityDate: "2026-11-04",
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                type: "esm",
                contents: bundle.outputFiles[0].text,
              },
            },
          },
          env: {
            DB: { type: "d1", id: "DB" },
            AUTH_MODE: { type: "text", value: "trial" },
            AUTH_PEPPER: {
              type: "text",
              value: randomBytes(32).toString("hex"),
            },
          },
        },
      },
    ],
  });
  db = await runtime.getD1Database("DB");
  const schema = await readFile(
    new URL("../migrations/0001_auth.sql", import.meta.url),
    "utf8",
  );
  for (const sql of schema.split(";").filter((s) => s.trim()))
    await db.prepare(sql).run();
});
after(async () => runtime?.dispose());
function post(action, payload, headers = {}) {
  return runtime.dispatchFetch(origin + "/api/auth/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}
function account(type = "embedded") {
  const walletSeed = randomBytes(32),
    loginSeed = type === "phantom" ? walletSeed : randomBytes(32);
  const profile = {
    type,
    address: bs58.encode(ed25519.getPublicKey(walletSeed)),
  };
  if (type !== "phantom")
    profile.vault = {
      salt: toBase64(randomBytes(16)),
      iv: toBase64(randomBytes(12)),
      ct: toBase64(randomBytes(80)),
    };
  return {
    profile,
    loginKey: toBase64(ed25519.getPublicKey(loginSeed)),
    loginSeed,
    walletSeed,
  };
}
async function issue(phoneHash, action) {
  const res = await post("challenge", { phoneHash, action });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const { trialCode: code, challengeId, audience } = await res.json();
  assert.equal(audience, origin);
  assert.match(code, /^\d{6}$/);
  return { phoneHash, code, challengeId };
}
function payload(action, c, a) {
  const message = transcript(
    action,
    origin,
    c.phoneHash,
    c.challengeId,
    a.profile,
    a.loginKey,
  );
  const proof = toBase64(ed25519.sign(message, a.loginSeed));
  if (action === "signin") return { ...c, proof };
  return {
    ...c,
    profile: a.profile,
    loginKey: a.loginKey,
    proof,
    walletProof: toBase64(ed25519.sign(message, a.walletSeed)),
  };
}
async function register(phoneHash, a) {
  const res = await post(
    "activate",
    payload("activate", await issue(phoneHash, "activate"), a),
  );
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { address: a.profile.address });
}
for (const type of ["embedded", "paper", "phantom"]) {
  test(
    type +
      " profile survives a fresh challenge; only the registered signer can retrieve it",
    async () => {
      const hash = await phoneDigest("test-fixture-" + type),
        a = account(type);
      await register(hash, a);
      const c = await issue(hash, "signin");
      const denied = await post("signin", payload("signin", c, account(type)));
      assert.equal(denied.status, 401);
      assert.deepEqual(Object.keys(await denied.json()), ["error"]);
      const res = await post("signin", payload("signin", c, a));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { profile: a.profile });
      const stored = await db
        .prepare("SELECT * FROM wallets WHERE login_key=?")
        .bind(a.loginKey)
        .first();
      assert.notEqual(stored.phone_key, hash);
      assert.deepEqual(JSON.parse(stored.profile), a.profile);
    },
  );
}
test("competing registrations cannot replace the winning wallet", async () => {
  const hash = await phoneDigest("race-registration"),
    accounts = [account(), account()];
  const reqs = await Promise.all(
    accounts.map(async (a) =>
      payload("activate", await issue(hash, "activate"), a),
    ),
  );
  const results = await Promise.all(reqs.map((r) => post("activate", r)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const winner = accounts[results.findIndex((r) => r.status === 201)];
  const res = await post(
    "signin",
    payload("signin", await issue(hash, "signin"), winner),
  );
  assert.deepEqual(await res.json(), { profile: winner.profile });
});
test("two simultaneous redemptions release a vault just once", async () => {
  const hash = await phoneDigest("replay"),
    a = account();
  await register(hash, a);
  const req = payload("signin", await issue(hash, "signin"), a);
  const result = await Promise.all([post("signin", req), post("signin", req)]);
  assert.deepEqual(result.map((r) => r.status).sort(), [200, 401]);
});
test("activation verifies wallet ownership and binds the entire ciphertext and login key", async () => {
  const hash = await phoneDigest("tamper"),
    a = account();
  const req = payload("activate", await issue(hash, "activate"), a);
  assert.equal(
    (await post("activate", { ...req, walletProof: req.proof })).status,
    401,
  );
  assert.equal(
    (
      await post("activate", {
        ...req,
        profile: {
          ...req.profile,
          vault: { ...req.profile.vault, ct: toBase64(randomBytes(80)) },
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (await post("activate", { ...req, loginKey: account().loginKey })).status,
    401,
  );
  assert.equal(
    (
      await post("activate", {
        ...req,
        profile: {
          ...req.profile,
          vault: { ...req.profile.vault, ct: "plaintext" },
        },
      })
    ).status,
    400,
  );
  assert.equal((await post("activate", req)).status, 201);
});
test("challenges expire and stop after five bad guesses; phone and purpose must match", async () => {
  const hash = await phoneDigest("lockout"),
    a = account(),
    req = payload("activate", await issue(hash, "activate"), a);
  assert.equal(
    (
      await post(
        "signin",
        payload(
          "signin",
          { phoneHash: hash, code: req.code, challengeId: req.challengeId },
          a,
        ),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await post("activate", {
        ...req,
        phoneHash: await phoneDigest("different"),
      })
    ).status,
    401,
  );
  const wrong = req.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++)
    assert.equal((await post("activate", { ...req, code: wrong })).status, 401);
  assert.equal((await post("activate", req)).status, 401);
  const exp = payload("activate", await issue(hash, "activate"), a);
  await db
    .prepare("UPDATE challenges SET expires=0 WHERE id=?")
    .bind(exp.challengeId)
    .run();
  assert.equal((await post("activate", exp)).status, 401);
});
test("throttles code issuance and never stores a readable code", async () => {
  const hash = await phoneDigest("throttle"),
    c = await issue(hash, "signin");
  const row = await db
    .prepare("SELECT * FROM challenges WHERE id=?")
    .bind(c.challengeId)
    .first();
  assert.notEqual(row.code_mac, c.code);
  assert.notEqual(row.phone_key, hash);
  for (let i = 1; i < 12; i++) await issue(hash, "signin");
  assert.equal(
    (await post("challenge", { phoneHash: hash, action: "signin" })).status,
    429,
  );
});
test("auth is same-origin, JSON-only and rejects oversized input and plaintext fields", async () => {
  const b = { phoneHash: await phoneDigest("formats"), action: "activate" };
  assert.equal(
    (await post("challenge", b, { Origin: "https://elsewhere.example" }))
      .status,
    403,
  );
  assert.equal(
    (await post("challenge", b, { "Content-Type": "text/plain" })).status,
    415,
  );
  assert.equal((await post("challenge", { ...b, password: "x" })).status, 400);
  assert.equal(
    (await post("challenge", { ...b, padding: "x".repeat(5000) })).status,
    413,
  );
  assert.equal(
    (await runtime.dispatchFetch(origin + "/api/auth/challenge")).status,
    405,
  );
  assert.equal(
    (await runtime.dispatchFetch(origin + "/api/missing")).status,
    404,
  );
  const status = await runtime.dispatchFetch(origin + "/api/auth/status");
  assert.equal(status.headers.get("X-Wara-Auth"), "1");
});
test("an unconfigured Worker refuses enrollment and serves only the requested static asset", async () => {
  const { default: worker } = await import("../worker/index.mjs");
  const request = new Request(origin + "/api/auth/challenge", {
    method: "POST",
  });
  for (const env of [
    {},
    { DB: db, AUTH_MODE: "trial" },
    {
      DB: db,
      AUTH_MODE: "disabled",
      AUTH_PEPPER: randomBytes(32).toString("hex"),
    },
  ]) {
    const res = await worker.fetch(request, env);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("X-Wara-Auth"), "1");
  }
  const res = await worker.fetch(new Request(origin + "/shop/"), {
    ASSETS: { fetch: (r) => new Response(new URL(r.url).pathname) },
  });
  assert.equal(await res.text(), "/shop/");
});

test("SMS registration and fresh-device sign-in require the delivered code and wallet signer", async (t) => {
  const worker = (await import("../worker/index.mjs")).default;
  const { beginAuth, activate, active, unlock, signout } = await import(
    "../mainstream/identity.mjs"
  );
  const env = {
    DB: db,
    AUTH_MODE: "sms",
    AUTH_PEPPER: randomBytes(32).toString("hex"),
    TWILIO_API_KEY: "SK" + "0".repeat(32),
    TWILIO_API_SECRET: randomBytes(16).toString("hex"),
    TWILIO_VERIFY_SERVICE_SID: "VA" + "0".repeat(32),
  };
  // Only the SMS provider is simulated. Calls go through the site client, Worker and D1.
  const sent = new Map();
  let latest,
    failDelivery = false;
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    if (url.startsWith("/api/"))
      return worker.fetch(new Request(origin + url, opts), env);
    const base =
      "https://verify.twilio.com/v2/Services/" + env.TWILIO_VERIFY_SERVICE_SID;
    assert.equal(
      opts.headers.Authorization,
      "Basic " + btoa(env.TWILIO_API_KEY + ":" + env.TWILIO_API_SECRET),
    );
    const form = opts.body;
    if (url === base + "/Verifications") {
      if (failDelivery) return new Response(null, { status: 503 });
      const sid = "VE" + randomBytes(16).toString("hex");
      const data = {
        sid,
        service_sid: env.TWILIO_VERIFY_SERVICE_SID,
        channel: form.get("Channel"),
        to: form.get("To"),
      };
      const code = String(
        crypto.getRandomValues(new Uint32Array(1))[0] % 1000000,
      ).padStart(6, "0");
      latest = code;
      sent.set(sid, { data, code });
      return Response.json({ ...data, status: "pending" });
    }
    assert.equal(url, base + "/VerificationCheck");
    const sid = form.get("VerificationSid"),
      message = sent.get(sid);
    if (!message) return new Response(null, { status: 404 });
    const ok = form.get("Code") === message.code;
    if (ok) sent.delete(sid);
    return Response.json({
      ...message.data,
      status: ok ? "approved" : "pending",
    });
  });
  function freshDevice() {
    globalThis.location = new URL(origin);
    for (const name of ["localStorage", "sessionStorage"]) {
      const values = new Map();
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
          setItem: (k, v) => values.set(k, v),
          getItem: (k) => values.get(k) ?? null,
          removeItem: (k) => values.delete(k),
        },
      });
    }
  }
  const phone = "+819000000000",
    pass = randomBytes(12).toString("hex");
  const start = (action) => beginAuth(phone, action, "sms");
  const use = (proof, password = pass, code = latest) =>
    activate(phone, "embedded", password, proof, code);
  freshDevice();
  // A trial account on this number must neither reserve it nor release its vault.
  env.AUTH_MODE = "trial";
  const trial = await beginAuth(phone, "activate");
  const old = await use(trial, pass + "old", trial.trialCode);
  freshDevice();
  env.AUTH_MODE = "sms";
  await assert.rejects(use(trial, pass + "old", trial.trialCode));
  failDelivery = true;
  await assert.rejects(start("activate"), /SMS/);
  failDelivery = false;
  const first = await start("activate");
  assert.equal(first.trialCode, undefined);
  const wrong = latest === "000000" ? "111111" : "000000";
  await assert.rejects(use(first, pass, wrong));
  const registered = await use(first);
  assert.notEqual(registered.address, old.address);
  signout();
  freshDevice();
  const second = await start("signin");
  await assert.rejects(use(second, pass + "old"));
  assert.equal(active(), null);
  const recovered = await use(second);
  assert.equal(
    (await unlock(recovered, pass)).publicKey.toBase58(),
    registered.address,
  );
  await assert.rejects(use(second));
});

test("Google phone sign-in is project-, number-, wallet- and challenge-bound", async (t) => {
  const { default: worker } = await import("../worker/index.mjs");
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(
      String(url),
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    );
    return Response.json({ keys: [{ ...jwk, alg: "RS256", kid: "test" }] });
  });
  const env = {
    DB: db,
    AUTH_PEPPER: randomBytes(32).toString("hex"),
    AUTH_MODE: "google",
    FIREBASE_PROJECT_ID: "wara-fixture",
    FIREBASE_APP_ID: "app",
    FIREBASE_WEB_API_KEY: "test",
  };
  async function request(action, data) {
    return worker.fetch(
      new Request(origin + "/api/auth/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
      env,
    );
  }
  const phone = "+819000000000",
    phoneHash = await phoneDigest(phone),
    a = account();
  const start = async (action) => {
    const res = await request("challenge", { phoneHash, action });
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.trialCode, undefined);
    assert.equal(info.firebase.projectId, env.FIREBASE_PROJECT_ID);
    return { phoneHash, challengeId: info.challengeId };
  };
  const time = () => Math.floor(Date.now() / 1000);
  async function token(overrides = {}) {
    return new SignJWT({
      sub: "user",
      iss: "https://securetoken.google.com/wara-fixture",
      aud: "wara-fixture",
      phone_number: phone,
      auth_time: time(),
      firebase: { sign_in_provider: "phone" },
      ...overrides,
    })
      .setIssuedAt()
      .setExpirationTime("1h")
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(privateKey);
  }
  const c = await start("activate"),
    req = payload("activate", c, a);
  for (const claims of [
    { aud: "foreign" },
    { phone_number: "+819000000001" },
    { auth_time: time() - 600 },
    { firebase: { sign_in_provider: "password" } },
  ]) {
    assert.equal(
      (await request("activate", { ...req, idToken: await token(claims) }))
        .status,
      401,
    );
  }
  const used = await token();
  assert.equal(
    (await request("activate", { ...req, idToken: used })).status,
    201,
  );
  const second = await start("signin"),
    signin = payload("signin", second, a);
  assert.equal(
    (await request("signin", { ...signin, idToken: used })).status,
    401,
  );
  // Separate phone authentications have second-resolution timestamps.
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const fresh = await token();
  assert.equal(
    (
      await request("signin", {
        ...payload("signin", second, account()),
        idToken: fresh,
      })
    ).status,
    401,
  );
  const res = await request("signin", { ...signin, idToken: fresh });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).profile, a.profile);

  // An earlier client registered this wallet. A fresh client entering through
  // registration must discover the sign-in step only after proving the phone.
  const existing = await start("activate");
  const resolve = (idToken) => request("resolve", { ...existing, action: "activate", idToken });
  assert.equal((await resolve(await token({ phone_number: "+819000000001" }))).status, 401);
  await new Promise(r => setTimeout(r, 1050));
  const valid = await token();
  const result = await resolve(valid);
  assert.equal(result.status, 200);
  const step = await result.json();
  assert.equal(step.action, "signin");
  assert.equal(step.type, "embedded");
  assert.deepEqual(Object.keys(step).sort(), ["action", "address", "challengeId", "type"]);
  assert.notEqual(step.challengeId, existing.challengeId);
  assert.equal((await resolve(valid)).status, 401);
  const finish = (signer, challengeId = step.challengeId) => request("signin",
    payload("signin", { phoneHash, challengeId, walletStep: true }, signer));
  assert.equal((await finish(a, existing.challengeId)).status, 401);
  assert.equal((await finish(account())).status, 401);
  assert.equal((await finish(a)).status, 200);
  assert.equal((await finish(a)).status, 401);
});

test("Google challenge retries refill one slot and a rejection consumes no slots", async () => {
  const { default: worker } = await import("../worker/index.mjs");
  const env = {
    DB: db, AUTH_MODE: "google", AUTH_PEPPER: randomBytes(32).toString("hex"),
    FIREBASE_PROJECT_ID: "wara-fixture", FIREBASE_APP_ID: "fixture", FIREBASE_WEB_API_KEY: "fixture",
  };
  const phoneHash = await phoneDigest("retry-fixture");
  const issue = () => worker.fetch(new Request(origin + "/api/auth/challenge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneHash, action: "signin" }),
  }), env);
  const burst = await Promise.all(Array.from({ length: 6 }, issue));
  assert.equal(burst.filter(r => r.status === 200).length, 5);
  const blocked = burst.find(r => r.status === 429);
  const message = (await blocked.json()).error;
  const seconds = Number(message.match(/(\d+)秒後/)?.[1]);
  assert.ok(seconds > 0 && seconds <= 60);
  const state = () => db.prepare("SELECT bucket, expires FROM issue_limits WHERE bucket LIKE 'google-issue:%' ORDER BY bucket").all();
  const before = await state();
  assert.equal((await issue()).status, 429);
  assert.deepEqual((await state()).results, before.results);
  await db.prepare("UPDATE issue_limits SET expires = expires - 60 WHERE bucket LIKE 'google-issue:phone:%'").run();
  assert.equal((await issue()).status, 200);
  assert.equal((await issue()).status, 429);
});

test("SMS-verified introduction, isolated child login, card scope and linking the same wallet", async t => {
  const { default: worker }=await import("../worker/index.mjs");
  const { walletMessage }=await import("../shared/member-wire.mjs");
  const { spend, transfer, join }=await import("../mainstream/protocol.mjs");
  const { budgetInstructions }=await import("../app/protocol.mjs");
  const { Keypair, Transaction, SystemProgram }=await import("@solana/web3.js");
  const {default:manifest}=await import("../deployments/devnet.json",{with:{type:"json"}});
  const sql=await readFile(new URL("../migrations/0002_wallet_access.sql",import.meta.url),"utf8");
  for(const statement of sql.trim().split(/;\s*(?=CREATE |$)/).filter(Boolean)) await db.prepare(statement).run();
  const env={DB:db,AUTH_PEPPER:randomBytes(32).toString("hex"),AUTH_MODE:"sms",WALLET_ACCESS:"enabled",
    TWILIO_VERIFY_SERVICE_SID:"VA"+"a".repeat(32),TWILIO_API_KEY:"SK"+"b".repeat(32),TWILIO_API_SECRET:"fixture"};
  const sent=new Map();
  t.mock.method(globalThis,"fetch",async (url,init)=>{
    if(String(url)===manifest.rpc) return Response.json({result:{value:true}});
    const params=init.body;
    const issuing=String(url).endsWith("/Verifications");
    const sid=issuing?"VE"+randomBytes(16).toString("hex"):params.get("VerificationSid");
    if(issuing)sent.set(sid,params.get("To"));
    if(!issuing && params.get("Code")!=="991105") return Response.json({},{status:404});
    return Response.json({sid,to:sent.get(sid),channel:"sms",service_sid:env.TWILIO_VERIFY_SERVICE_SID,status:issuing?"pending":"approved"});
  });
  const request=async(path,body,status=200)=>{
    const r=await worker.fetch(new Request(origin+"/api/"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),env);
    const result=await r.json();assert.equal(r.status,status,path+" "+(result.error||""));return result;
  };
  const call=(path,body,status)=>request("member/"+path,body,status);
  async function verified(phone,action){
    const phoneHash=await phoneDigest(phone),issued=await request("auth/challenge",{phone,action});
    const step=await request("auth/resolve",{phoneHash,action,challengeId:issued.challengeId,code:"991105"});
    return {phoneHash,challengeId:step.challengeId};
  }
  const secret=()=>bs58.encode(randomBytes(32)),cards=()=>({card:secret(),codes:Array.from({length:6},secret)});
  // Seed legacy records through the old API, then migrate via the deployed API.
  for (const [i,type] of ["phantom","embedded"].entries()) {
    const legacy=account(type),phone="+1202555010"+i, hash=await phoneDigest(phone);
    const init=await verified(phone,"activate");
    const old=await worker.fetch(new Request(origin+"/api/auth/activate",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({...payload("activate",init,legacy),walletStep:true})}),{...env,WALLET_ACCESS:"disabled"});
    assert.equal(old.status,201);
    const step=await verified(phone,"signin");
    const args={...step,pin:"002467",type,legacy:true};
    if(type==="embedded"){
      const proof=payload("signin",step,legacy).proof;
      const vault=await call("legacy-vault",{...step,proof});assert.equal(vault.profile.address,legacy.profile.address);
      await call("enroll",{...args,...cards(),seed:toBase64(randomBytes(32))},401);
      Object.assign(args,cards(),{seed:toBase64(legacy.walletSeed)});
    } else {
      args.address=legacy.profile.address;
      args.signature=toBase64(ed25519.sign(walletMessage(origin,"register",step.challengeId,args.address),legacy.walletSeed));
    }
    assert.equal((await call("enroll",args)).profile.address,legacy.profile.address);
  }
  const ph=account("phantom"),phone="+819012340811",pin="001472",childPin="004123";
  const create=await verified(phone,"activate");
  const parent=await call("enroll",{...create,pin,type:"phantom",address:ph.profile.address,
    signature:toBase64(ed25519.sign(walletMessage(origin,"register",create.challengeId,ph.profile.address),ph.walletSeed))});
  const step=await verified(phone,"signin");
  await call("phone-login",{...step,pin:"999991"},401);
  const pending=await call("phone-login",{...step,pin});
  assert.equal(pending.session,undefined);
  const msg=walletMessage(origin,"signin",pending.signatureTicket,ph.profile.address);
  await call("signature",{ticket:pending.signatureTicket,signature:toBase64(ed25519.sign(msg,account("phantom").walletSeed))},401);
  const second=pending;
  const sg=toBase64(ed25519.sign(walletMessage(origin,"signin",second.signatureTicket,ph.profile.address),ph.walletSeed));
  const rawPost=(op,body,headers={})=>worker.fetch(new Request(origin+"/api/member/"+op,{
    method:"POST",headers:{"Content-Type":"application/json",Origin:origin,...headers},body:JSON.stringify(body)}),env);
  const signedResponse=await rawPost("signature",{ticket:second.signatureTicket,signature:sg,mobileReturn:true});
  const freshParent=await signedResponse.json();assert.equal(freshParent.profile.address,parent.profile.address);
  const setCookie=signedResponse.headers.get("Set-Cookie");
  for(const part of ["__Host-wara-phantom=","Path=/","Secure","HttpOnly","SameSite=Strict","Max-Age=900"])assert.ok(setCookie.includes(part));
  const Cookie=setCookie.split(";")[0];
  assert.equal((await rawPost("phantom-return",{session:freshParent.session})).status,401);
  assert.equal((await rawPost("phantom-return",{},{Cookie,Origin:"https://elsewhere.example"})).status,403);
  const returning=await rawPost("phantom-return",{},{Cookie});
  assert.equal(returning.headers.get("Set-Cookie"),null);
  const resumed=await returning.json();
  assert.equal(resumed.expires,freshParent.expires);
  assert.equal(resumed.session,freshParent.session);
  assert.equal(resumed.profile.address,ph.profile.address);
  assert.equal((await rawPost("logout",{session:freshParent.session},{Cookie})).status,200);
  assert.equal((await rawPost("phantom-return",{},{Cookie})).status,401);
  const sheet=cards(),answers=["白山","鳥羽","名古屋","","",""],name="架空 太郎";
  const registration={...sheet,pin:childPin,name,answers};
  await call("introduce",registration,401);
  const introduced=await call("introduce",{...registration,session:parent.session});
  assert.deepEqual(Object.keys(introduced),["address"]);assert.notEqual(introduced.address,parent.profile.address);
  async function quiz(){
    const q=await call("questions",{name:"架空　太郎"});
    assert.equal(new Set(q.ids).size,2);return {ticket:q.ticket,answers:q.ids.map(i=>answers[i])};
  }
  await call("name-login",{...await quiz(),pin:childPin,answers:["wrong","wrong"]},401);
  const proof=await quiz();
  const child=await call("name-login",{...proof,pin:childPin});
  assert.equal(child.profile.address,introduced.address);
  await call("name-login",{...proof,pin:childPin},401);
  await call("introduce",{...registration,session:child.session},403);
  await call("pin",{session:child.session,newPin:"884411"},401);
  await call("card-info",{card:introduced.address},401);
  const g=Keypair.generate().publicKey,store=Keypair.generate().publicKey, payer=new (await import("@solana/web3.js")).PublicKey(introduced.address);
  const blockhash=String(Keypair.generate().publicKey);
  const raw=ix=>new Transaction({feePayer:payer,recentBlockhash:blockhash}).add(...ix).serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64");
  const send=spend(manifest.program,payer,g,store,1,10,1);
  const checkout={group:String(g),store:String(store),amount:1};
  const cardBody={card:sheet.card,pin:childPin,checkout,tx:raw([budgetInstructions()[1],...send])};
  const signed=await call("card-sign",cardBody);
  assert.ok(ed25519.verify(Buffer.from(signed.signature,"base64"),Transaction.from(Buffer.from(cardBody.tx,"base64")).serializeMessage(),payer.toBytes()));
  await call("card-sign",{...cardBody,checkout:{...checkout,amount:2}},401);
  await call("card-sign",{...cardBody,tx:raw([SystemProgram.transfer({fromPubkey:payer,toPubkey:store,lamports:10}),...send])},401);
  const pay=raw([budgetInstructions()[1],...transfer(manifest.program,payer,g,store,[{origin:g,amount:2n}])]);
  await call("card-sign",{...cardBody,tx:pay},401);
  await call("sign",{session:child.session,tx:pay},401);
  await call("sign",{session:child.session,tx:pay,code:sheet.codes[0]});
  await call("sign",{session:child.session,tx:pay,code:sheet.codes[0]},401);
  await call("sign",{session:child.session,tx:raw([...budgetInstructions(),join(manifest.program,payer,g,payer)])});
  // The site-held signer keeps the same card and confirmation-sheet scope
  // when a second key pays the fee and funds the daily allowance account.
  const sponsor = Keypair.generate();
  env.FEE_PAYER_SECRET = bs58.encode(sponsor.secretKey);
  const {sponsoredInstructions} = await import("../shared/sponsorship.mjs");
  const sponsoredTx = instructions => new Transaction({feePayer:sponsor.publicKey,recentBlockhash:blockhash})
    .add(...instructions).serialize({requireAllSignatures:false}).toString("base64");
  const sponsoredCard = sponsoredTx(sponsoredInstructions([budgetInstructions()[1],...send],sponsor.publicKey,1000000));
  const proofForSponsor = await call("card-sign",{...cardBody,tx:sponsoredCard});
  assert.ok(ed25519.verify(Buffer.from(proofForSponsor.signature,"base64"),
    Transaction.from(Buffer.from(sponsoredCard,"base64")).serializeMessage(),payer.toBytes()));
  await call("card-sign",{...cardBody,tx:sponsoredCard,checkout:{...checkout,amount:2}},401);
  const sponsoredWara = sponsoredTx(sponsoredInstructions([budgetInstructions()[1],
    ...transfer(manifest.program,payer,g,store,[{origin:g,amount:2n}])], sponsor.publicKey,0));
  await call("sign",{session:child.session,tx:sponsoredWara},401);
  await call("sign",{session:child.session,tx:sponsoredWara,code:sheet.codes[2]});
  const ownPhone="+819012340833";
  await call("link",{...await verified(ownPhone,"activate"),session:child.session,code:sheet.codes[1]});
  const linked=await call("phone-login",{...await verified(ownPhone,"signin"),pin:childPin});
  assert.equal(linked.profile.address,introduced.address);
  await call("introduce",{...registration,...cards(),session:parent.session});
  await call("introduce",{...registration,...cards(),session:parent.session});
  await call("introduce",{...registration,...cards(),session:parent.session},429);
  const rotated=cards();await call("cards",{session:linked.session,code:sheet.codes.at(-1),...rotated});
  await call("card-info",{card:sheet.card},401);
  assert.equal((await call("card-info",{card:rotated.card})).address,introduced.address);
});
