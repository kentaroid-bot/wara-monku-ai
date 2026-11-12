import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import worker from "../worker/index.mjs";
import { Failure } from "../worker/failure.mjs";
import { cleanupTickets } from "../worker/member-core.mjs";
import { memberSettings } from "../worker/member-settings.mjs";
import { memberSigning } from "../worker/member-signing.mjs";
import { communityMetadata } from "../worker/community-metadata.mjs";
import { mintFor, pk, tok, metadata } from "../shared/protocol.mjs";
import manifest from "../shared/deployment.mjs";
import securityHeaders from "../shared/security-headers.cjs";

// Let esbuild parse static imports, re-exports and dynamic imports instead of
// relying on line formatting. Third-party packages remain valid dependencies.
test("Worker and shared modules cannot depend on frontend or scripts", async () => {
  const entryPoints = [];
  for (const directory of ["worker", "shared"])
    for (const file of await readdir(directory))
      if (file.endsWith(".mjs")) entryPoints.push(`${directory}/${file}`);
  const imports = [];
  await build({
    entryPoints, outdir: "unused", bundle: true, write: false, logLevel: "silent",
    plugins: [{ name: "inspect-layers", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind === "entry-point") return;
        imports.push(args);
        return { path: args.path, external: true };
      });
    } }],
  });
  for (const { path, importer } of imports) {
    assert.doesNotMatch(path, /(?:^|\/)(?:mainstream|app|scripts)\//, importer);
    if (importer.includes("/worker/") && path.startsWith("."))
      assert.ok(path.startsWith("./") || path.startsWith("../shared/"), `${importer}: ${path}`);
  }
});

test("legacy export surfaces keep the shared implementations", async () => {
  const shared = await import("../shared/protocol.mjs");
  for (const path of ["../app/protocol.mjs", "../mainstream/protocol.mjs"]) {
    const legacy = await import(path);
    for (const [name, value] of Object.entries(legacy)) assert.equal(value, shared[name], name);
  }
  assert.deepEqual(await import("../scripts/token-metadata.mjs"), await import("../shared/token-metadata.mjs"));
  assert.equal(shared.LIMIT, 300n);
  assert.equal(shared.quota(null, 0n).remaining, 10n);
});

test("unexpected API errors are logged but never exposed to clients", async t => {
  const error = new Error("sensitive database failure marker");
  const log = t.mock.method(console, "error", () => {});
  const response = await worker.fetch(new Request("https://wara.example/api/member/questions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), { AUTH_MODE: "trial", WALLET_ACCESS: "enabled", AUTH_PEPPER: "x".repeat(32),
    DB: { prepare() { throw error; } } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "認証APIを利用できません。時間をおいて再試行してください。" });
  assert.equal(log.mock.callCount(), 1);
  assert.match(String(log.mock.calls[0].arguments[1]), /sensitive database failure marker/);
  for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers.get(name), value);
});

test("ticket cleanup runs at most once per minute per binding, including concurrent callers", async () => {
  const calls = [];
  const db = { prepare(sql) {
    assert.equal(sql, "DELETE FROM wallet_tickets WHERE expires<=?");
    return { bind(now) { return { async run() { calls.push(now); } }; } };
  } };
  await Promise.all([cleanupTickets(db, 100), cleanupTickets(db, 100)]);
  await cleanupTickets(db, 159);
  assert.deepEqual(calls, [100]);
  await cleanupTickets(db, 160);
  assert.deepEqual(calls, [100, 160]);
});

test("failed ticket cleanup can be retried", async () => {
  let calls = 0;
  const db = { prepare: () => ({ bind: () => ({ async run() {
    if (++calls === 1) throw Error("temporary failure");
  } }) }) };
  await assert.rejects(cleanupTickets(db, 100), /temporary failure/);
  await cleanupTickets(db, 101);
  assert.equal(calls, 2);
});

function settingsFixture(t, stale = false) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const query = (sql, ...args) => ({ sql, args, first: async () => sqlite.prepare(sql).get(...args) });
  const db = { async batch(statements) {
    sqlite.exec("BEGIN");
    try {
      const results = statements.map(({ sql, args }) => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }));
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  } };
  const m = { id: "member", revision: 1, type: "embedded", address: "wallet" };
  return { sqlite, core: {
    b: { newPin: "123456", card: "new-card", codes: Array.from({ length: 6 }, (_, i) => `new-code-${i}`) },
    db, query, realm: "verified", session: async () => ({ m }),
    hash: async (purpose, value) => `${purpose}:${value}`, validPin() {}, cardValues() {},
    alias: async () => ({ nameKey: "new-name", answers: "new-answers" }),
    consumePhone: async () => "new-phone", profile: member => ({ address: member.address }),
    strong: async () => { if (stale) sqlite.exec("UPDATE members SET revision=revision+1 WHERE id='member'"); },
    fail: (status, message) => { throw new Failure(status, message); },
    bad: () => { throw new Failure(400, "bad"); }, denied: () => { throw new Failure(401, "denied"); },
  } };
}

for (const op of ["pin", "alias", "link", "cards"]) {
  for (const stale of [false, true]) test(`settings ${op}: ${stale ? "stale revision leaves all settings intact" : "updates atomically"}`, async t => {
    const { sqlite, core } = settingsFixture(t, stale);
    sqlite.exec(await readFile(new URL("../migrations/0001_auth.sql", import.meta.url), "utf8"));
    sqlite.exec(await readFile(new URL("../migrations/0002_wallet_access.sql", import.meta.url), "utf8"));
    sqlite.exec("INSERT INTO members(id,realm,address,type,pin_mac,sealed_seed,card_key,name_key,answers,created) VALUES('member','verified','wallet','embedded','old-pin','original-sealed-seed','old-card','old-name','old-answers',0)");
    sqlite.exec("INSERT INTO wallet_codes VALUES('member','old-code',0)");
    const before = sqlite.prepare("SELECT * FROM members").get();
    if (stale) {
      await assert.rejects(memberSettings(op, core), error => error.status === 409 && error.message === "アカウント設定が別の操作で更新されました。もう一度お試しください。");
      assert.deepEqual({ ...sqlite.prepare("SELECT * FROM members").get() }, { ...before, revision: 2 });
      assert.equal(sqlite.prepare("SELECT code_key FROM wallet_codes").get().code_key, "old-code");
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM wallets").get().n, 0);
    } else {
      assert.deepEqual(await memberSettings(op, core), { reauth: true });
      const member = sqlite.prepare("SELECT * FROM members").get();
      assert.equal(member.revision, 2);
      assert.equal(member.sealed_seed, "original-sealed-seed");
      if (op === "pin") assert.equal(member.pin_mac, "pin:member:123456");
      if (op === "alias") assert.equal(member.name_key, "new-name");
      if (op === "link") {
        assert.equal(member.phone_key, "new-phone");
        assert.equal(sqlite.prepare("SELECT phone_key FROM wallets").get().phone_key, "new-phone");
      }
      if (op === "cards") {
        assert.equal(member.card_key, "card:new-card");
        assert.equal(sqlite.prepare("SELECT count(*) AS n FROM wallet_codes").get().n, 6);
        assert.equal(sqlite.prepare("SELECT count(*) AS n FROM wallet_codes WHERE code_key='old-code'").get().n, 0);
      }
    }
  });
}

test("settings tolerate old D1 mocks without meta", async t => {
  const { core } = settingsFixture(t);
  core.db.batch = async () => [{}];
  assert.deepEqual(await memberSettings("pin", core), { reauth: true });
});

test("signing preserves denied 401 while malformed transactions remain 400", async () => {
  const payer = Keypair.generate().publicKey;
  const tx = new Transaction({ feePayer: payer, recentBlockhash: String(Keypair.generate().publicKey) })
    .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  const core = { env: {}, b: { tx: tx.serialize({ requireAllSignatures: false }).toString("base64") },
    session: async () => ({ m: { type: "embedded", address: String(payer) } }),
    denied: () => { throw new Failure(401, "denied"); }, bad: () => { throw new Failure(400, "bad"); } };
  await assert.rejects(memberSigning("sign", core), error => error.status === 401);
  core.b.tx = "malformed";
  await assert.rejects(memberSigning("sign", core), error => error.status === 400);
});

test("metadata caches mint discovery in memory but rechecks live visibility", async t => {
  const program = pk(manifest.program), group = Keypair.generate().publicKey;
  const mint = mintFor(program, group), owner = Keypair.generate().publicKey;
  const mintData = Buffer.alloc(82);
  mintData.writeUInt32LE(1); mint.toBuffer().copy(mintData, 4); mintData[45] = 1;
  let hidden = false, scans = 0;
  const rpc = {
    async getProgramAccounts() { scans++; return [{ pubkey: group }]; },
    async getAccountInfo(address) {
      if (address.equals(mint)) return { owner: tok, data: mintData };
      if (address.equals(group)) return { owner: program, data: Buffer.concat([
        Buffer.from([31]), owner.toBuffer(), Buffer.from([0]), SystemProgram.programId.toBuffer(),
        hidden ? Buffer.from(JSON.stringify({ visibility: "private", sealed: "hidden" })) : metadata("春の町", "市場", "地域"),
      ]) };
      return null;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, value: undefined });
  t.after(() => original ? Object.defineProperty(globalThis, "caches", original) : delete globalThis.caches);
  const req = new Request(`https://wara.example/api/v3/metadata/${mint}.json`);
  assert.equal((await (await communityMetadata(req, {}, {}, rpc)).json()).name, "春の町 WARA");
  hidden = true;
  const response = await communityMetadata(req, {}, {}, rpc);
  assert.equal(response.status, 200);
  const masked = await response.json();
  assert.equal(masked.name, "WARA");
  assert.equal(masked.attributes[0].value, "Private");
  assert.equal(scans, 1);
});
