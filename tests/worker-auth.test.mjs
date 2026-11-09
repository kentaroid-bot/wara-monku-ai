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
