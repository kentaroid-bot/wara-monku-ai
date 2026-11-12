import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { readCommunityProfiles, saveCommunityProfile, renameCommunity } from "../worker/community-profiles.mjs";
import { observeAccess, invalidateAccess, accessRows } from "../worker/community-access.mjs";
import { makePolicy, displayKeyBytes } from "../mainstream/community-privacy.mjs";
import { privateProfileVersion } from "../shared/private-community.mjs";
import { parseRow, pk, DEVNET_GENESIS } from "../shared/protocol.mjs";
import manifest from "../shared/deployment.mjs";

const address = () => String(Keypair.generate().publicKey);
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const hash = async (purpose, value) => createHash("sha256").update(purpose + value).digest("base64");
async function fixture(t) {
  t.mock.method(globalThis, "setTimeout", fn => { queueMicrotask(fn); return 0; });
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  for (const migration of ["0006_private_community_profiles", "0007_private_community_names", "0008_community_access"])
    sql.exec(readFileSync(new URL(`../migrations/${migration}.sql`, import.meta.url), "utf8"));
  const db = {prepare: query => ({bind: (...args) => ({
    first: async () => sql.prepare(query).get(...args),
    all: async () => ({results: sql.prepare(query).all(...args)}),
    run: async () => ({meta: sql.prepare(query).run(...args)}),
  })})};
  const id = address(), owner = address(), viewer = address(), now = Math.floor(Date.now()/1000);
  const policy = await makePolicy({visibility:"private", mode:1, name:"元の町", description:"参加者だけ", category:"地域"},
    id, owner, () => bs58.encode(Keypair.generate().secretKey.slice(0,32)));
  const account = {owner:pk(manifest.program), data:Buffer.concat([
    Buffer.from([31]), pk(owner).toBuffer(), Buffer.from([1]), policy.invite.toBuffer(), policy.bytes,
  ])};
  const group = parseRow(account.data, id), version = await privateProfileVersion(group);
  let status = 2, reads = 0, offline = false;
  const rpc = {getGenesisHash:async () => DEVNET_GENESIS, getAccountInfo:async () => account,
    getMultipleAccountsInfo:async keys => {
      reads++;
      if (offline) throw Error("429/503");
      assert.equal(keys.length,2);
      return [account, {owner:pk(manifest.program),data:Buffer.concat([
        Buffer.from([33]),pk(id).toBuffer(),pk(viewer).toBuffer(),Buffer.from([status]),
      ])}];
    }};
  await saveCommunityProfile(db,rpc,"realm",owner,{group:id,sealed:group.sealed,invite:group.invite,
    displayKey:Buffer.from(await displayKeyBytes(policy.code)).toString("base64")},hash,fail);
  const rename = () => renameCommunity(db,rpc,"realm",owner,
    {group:id,sealed:group.sealed,invite:group.invite,name:"改名した町",revision:0},hash,fail);
  const read = (versions=[version], force=false, ids=[id], realm="realm", who=viewer) =>
    readCommunityProfiles(db,[rpc],realm,who,ids,hash,fail,versions,force);
  const observe = (allowed=group, at=now, who=viewer) => observeAccess(db,"realm",who,id,version,allowed,0,at);
  return {db,sql,id,owner,viewer,group,version,now,read,observe,rename,
    reads:()=>reads, offline:()=>{offline=true;}, status:value=>{status=value;}};
}

test("force reuses verified member/owner access and reads the current D1 name without RPC", async t => {
  const f = await fixture(t);
  for (const who of [f.viewer,f.owner]) await f.observe(f.group,f.now,who);
  await f.rename();
  f.offline();
  for (const who of [f.viewer,f.owner]) {
    const result = await f.read([f.version],true,[f.id],"realm",who);
    assert.equal(result.groups[0].name,"改名した町");
    assert.equal(result.groups[0].unlocked,true);
  }
  assert.equal(f.reads(),0);
});

test("force rechecks a fresh negative cache immediately after admission", async t => {
  const f = await fixture(t);
  await f.observe(null);
  assert.deepEqual(await f.read(),{groups:[]});
  assert.equal(f.reads(),0);
  const admitted = await f.read([f.version],true);
  assert.equal(admitted.groups[0].name,"元の町");
  assert.equal(f.reads(),1);
  assert.equal((await f.read()).groups.length,1);
  assert.equal(f.reads(),1);
});

test("RPC outage rescues expired verified access with the current name without extending its TTL", async t => {
  const f = await fixture(t);
  await f.observe(f.group,f.now-301);
  await f.rename(); f.offline();
  assert.equal((await f.read([f.version],true)).groups[0].name,"改名した町");
  const row = (await accessRows(f.db,"realm",f.viewer,[f.id])).get(f.id);
  assert.equal(row.valid_until,f.now-1);
  assert.equal(f.reads(),3);
});

for (const condition of ["unknown", "negative", "revoked", "live", "version", "no hint", "realm", "wallet"])
  test(`RPC outage never discloses a profile with ${condition} access`, async t => {
    const f = await fixture(t);
    if (condition !== "unknown") await f.observe(condition === "negative" ? null : f.group,f.now-301);
    if (condition === "revoked") await invalidateAccess(f.db,"realm",f.viewer,f.id);
    if (condition === "live") f.sql.prepare("UPDATE community_access SET live_until=?").run(f.now+600);
    f.offline();
    await assert.rejects(f.read(condition === "version" ? ["f".repeat(64)] : condition === "no hint" ? [] : [f.version],
      true,[f.id],condition === "realm" ? "other" : "realm",condition === "wallet" ? address() : f.viewer),{status:503});
  });

test("partial RPC failure reports only unresolved IDs while preserving fresh and stale grants", async t => {
  const f = await fixture(t), other=address(), fresh=address();
  await f.observe(f.group,f.now-301);
  const second = {...f.group,id:fresh};
  const version = await privateProfileVersion(second);
  await observeAccess(f.db,"realm",f.viewer,fresh,version,second,0,f.now);
  f.offline();
  const result = await f.read([f.version,"e".repeat(64),version],false,[f.id,other,fresh]);
  assert.deepEqual(result.groups.map(g=>g.id),[f.id,fresh]);
  assert.deepEqual(result.unavailable,[other]);
});

test("a successful live read of departure or BAN replaces expired access with a denial", async t => {
  for (const status of [0,1,4]) {
    const f = await fixture(t);
    await f.observe(f.group,f.now-301); f.status(status);
    assert.deepEqual(await f.read(),{groups:[]});
    f.offline();
    await assert.rejects(f.read([f.version],true),{status:503});
  }
});
