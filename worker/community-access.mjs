import manifest from "../shared/deployment.mjs";

// Scope positive and negative observations to the exact wallet and deployment.
// An invalidation increments the generation so an older RPC read cannot undo it.
const scope = (realm, viewer) => [realm, manifest.program, viewer];
export async function accessRows(db, realm, viewer, keys) {
  if (!viewer || !keys.length) return new Map();
  const {results} = await db.prepare(`SELECT * FROM community_access WHERE realm=? AND program=? AND viewer=?
    AND group_id IN (${keys.map(()=>"?").join(",")})`).bind(...scope(realm,viewer),...keys).all();
  return new Map(results.map(r=>[r.group_id,r]));
}
export function freshAccess(row, now) {
  return row && row.valid_until > now && row.live_until <= now;
}
export async function observeAccess(db, realm, viewer, id, version, group, generation, now) {
  await db.prepare(`INSERT INTO community_access(realm,program,viewer,group_id,version,group_json,valid_until)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(realm,program,group_id,viewer) DO UPDATE SET
    version=excluded.version,group_json=excluded.group_json,valid_until=excluded.valid_until
    WHERE generation=? AND live_until<=?`).bind(...scope(realm,viewer),id,version,
      group ? JSON.stringify(group) : null, now+(group ? 300 : 30),generation,now).run();
}
export async function invalidateAccess(db,realm,viewer,id) {
  const now = Math.floor(Date.now()/1000);
  await db.prepare(`INSERT INTO community_access(realm,program,viewer,group_id,generation,live_until)
    VALUES(?,?,?,?,1,?) ON CONFLICT(realm,program,group_id,viewer) DO UPDATE SET
    generation=generation+1,valid_until=0,group_json=NULL,live_until=excluded.live_until`)
    .bind(...scope(realm,viewer),id,now+600).run();
}
