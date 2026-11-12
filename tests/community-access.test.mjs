import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { accessRows, freshAccess, invalidateAccess, observeAccess } from "../worker/community-access.mjs";

test("a delayed membership observation cannot restore a revoked grant; grants expire and stay wallet/realm scoped", async()=>{
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(readFileSync(new URL("../migrations/0008_community_access.sql",import.meta.url),"utf8"));
    const db = {prepare:q=>({bind:(...args)=>({all:()=>({results:sql.prepare(q).all(...args)}),run:()=>sql.prepare(q).run(...args)})})};
    const now = Math.floor(Date.now()/1000), group={id:"group",sealed:"ciphertext"};
    const write=(gen,at)=>observeAccess(db,"r","viewer",group.id,"v",group,gen,at);
    const read=async()=> (await accessRows(db,"r","viewer",[group.id])).get(group.id);
    await write(0,now);
    assert.ok(freshAccess(await read(),now+299));
    assert.ok(!freshAccess(await read(),now+300));
    assert.equal((await accessRows(db,"other","viewer",[group.id])).size,0);
    assert.equal((await accessRows(db,"r","other",[group.id])).size,0);
    await invalidateAccess(db,"r","viewer",group.id);
    const locked=await read();
    await write(0,now);
    await write(locked.generation,now);
    await write(0,locked.live_until+1);
    assert.equal((await read()).group_json,null);
    await write(locked.generation,locked.live_until+1);
    assert.deepEqual(JSON.parse((await read()).group_json),group);
  } finally { sql.close(); }
});
