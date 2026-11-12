import { Buffer } from "buffer";
import manifest from "../shared/deployment.mjs";
import { assertDevnet } from "../shared/protocol.mjs";
import { addr, pk } from "../shared/protocol.mjs";
import { openPrivateProfile, privateProfileVersion } from "../shared/private-community.mjs";
import { address, decode } from "./shop-profiles.mjs";

import { accessRows, freshAccess, observeAccess, invalidateAccess } from "./community-access.mjs";
import { readCommunityAccounts } from "./community-read.mjs";

const program = pk(manifest.program);

// Separate from wallet encryption, scoped to realm, program, group and version.
async function protect(hash, group, version, value, decrypt = false) {
  const scope = `${program}/${group}/${version}`;
  const key = await crypto.subtle.importKey("raw", Buffer.from(await hash("community-profile", scope), "base64"),
    "AES-GCM", false, [decrypt ? "decrypt" : "encrypt"]);
  const bytes = decrypt ? Buffer.from(value, "base64") : null;
  const iv = bytes ? bytes.subarray(0,12) : crypto.getRandomValues(new Uint8Array(12));
  const params = {name:"AES-GCM", iv, additionalData:Buffer.from(scope)};
  if (decrypt) return JSON.parse(Buffer.from(await crypto.subtle.decrypt(params,key,bytes.subarray(12))).toString("utf8"));
  return Buffer.concat([iv, new Uint8Array(await crypto.subtle.encrypt(params,key,Buffer.from(JSON.stringify(value))))]).toString("base64");
}

async function ownedPrivateGroup(rpc, viewer, body, fail) {
  const id = address(body.group, fail);
  let groupAccount;
  try {
    await assertDevnet(rpc);
    groupAccount = await rpc.getAccountInfo(pk(id), "confirmed");
  } catch {
    fail(503, "Devnetからコミュニティ情報を取得できませんでした。少し待ってから再試行してください。");
  }
  const group = decode(groupAccount, id);
  if (group?.tag !== 31 || group.owner !== viewer) fail(403, "管理者だけがコミュニティ情報を同期できます。");
  if (group.visibility !== "private" || body.sealed !== group.sealed || body.invite !== group.invite)
    fail(409, "コミュニティの設定が更新されています。画面を更新してください。");
  return group;
}

async function currentProfile(db, realm, group, hash) {
  const version = await privateProfileVersion(group);
  const row = await db.prepare(`SELECT p.sealed_profile, n.sealed_name, n.revision
    FROM (SELECT ? AS realm, ? AS group_id, ? AS version) AS k
    LEFT JOIN private_community_profiles AS p USING (realm,group_id,version)
    LEFT JOIN private_community_names AS n USING (realm,group_id,version)`)
    .bind(realm,group.id,version).first();
  const profile = row.sealed_profile ? await protect(hash,group.id,version,row.sealed_profile,true) : null;
  const name = row.sealed_name ? await protect(hash,group.id,"name/"+version,row.sealed_name,true) : null;
  return {...group,...profile,...(name ? {name, nameRevision:row.revision} : {}), joined:true, unlocked:Boolean(profile)};
}

export async function renameCommunity(db, rpc, realm, viewer, body, hash, fail) {
  const name = typeof body.name === "string" && body.name.trim();
  const revision = body.revision;
  if (!name || name.length > 50 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) ||
      !Number.isSafeInteger(revision) || revision < 0) fail(400, "名前は50文字以内で入力してください。");
  const group = await ownedPrivateGroup(rpc, viewer, body, fail);
  const version = await privateProfileVersion(group);
  const encrypted = await protect(hash, group.id, "name/"+version, name);
  const write = revision === 0
    ? db.prepare("INSERT INTO private_community_names VALUES(?,?,?,?,1) ON CONFLICT DO NOTHING")
        .bind(realm,group.id,version,encrypted)
    : db.prepare(`UPDATE private_community_names SET sealed_name=?, revision=revision+1
        WHERE realm=? AND group_id=? AND version=? AND revision=?`).bind(encrypted,realm,group.id,version,revision);
  if (!(await write.run()).meta.changes) fail(409,"別の画面で名前が更新されました。「更新」で確認してください。");
  return {name, nameRevision:revision+1};
}

export async function saveCommunityProfile(db, rpc, realm, viewer, body, hash, fail) {
  const group = await ownedPrivateGroup(rpc, viewer, body, fail);
  const id = group.id;
  let profile;
  try {
    const key = Buffer.from(body.displayKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== body.displayKey) throw Error();
    profile = await openPrivateProfile(group, key);
  } catch { fail(400, "現在のコミュニティ情報を復号できません。"); }
  const version = await privateProfileVersion(group);
  const sealed = await protect(hash, id, version, profile);
  // Immutable snapshots: late writes cannot replace a newer on-chain version.
  await db.prepare(`INSERT INTO private_community_profiles(realm,group_id,version,sealed_profile)
    VALUES(?,?,?,?) ON CONFLICT DO NOTHING`).bind(realm,id,version,sealed).run();
  return {group:await currentProfile(db,realm,group,hash)};
}

export async function resetCommunityAccess(db, readers, realm, viewer, body, fail) {
  const id = address(body.group,fail), target = address(body.member,fail);
  if (target !== viewer) {
    const [account] = await readCommunityAccounts(readers,[pk(id)],fail);
    const group = decode(account,id);
    if (group?.tag !== 31 || group.owner !== viewer) fail(403,"管理者だけが他の参加者の資格を更新できます。");
  }
  await invalidateAccess(db,realm,target,id);
  return {ok:true};
}

export async function readCommunityProfiles(db, readers, realm, viewer, ids, hash, fail, versions = [], force = false) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 32) fail(400, "コミュニティの指定を確認してください。");
  if (!Array.isArray(versions) || (versions.length && (versions.length !== ids.length ||
      versions.some(v=>typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))))) fail(400,"設定の版を確認してください。");
  const keys = [...new Set(ids.map(id => address(id, fail)))];
  const hints = new Map(ids.map((id,i)=>[id,versions[i]]));
  const now = Math.floor(Date.now()/1000);
  const existing = await accessRows(db,realm,viewer,keys), allowed = new Map(), missing = [];
  for (const id of keys) {
    const row = existing.get(id);
    if (!freshAccess(row,now) || row.version !== hints.get(id) || (force && !row?.group_json)) missing.push(id);
    else if (row.group_json) allowed.set(id, JSON.parse(row.group_json));
  }
  let unavailable;
  if (missing.length) {
    const memberships = missing.map(id => addr(program,"m3",id,viewer));
    let accounts;
    try { accounts = await readCommunityAccounts(readers,[...missing.map(pk),...memberships],fail); }
    catch (err) {
      // Only previously verified grants for this exact policy may survive an
      // RPC outage. Revocation clears group_json and forces live reads.
      const unresolved = [];
      for (const id of missing) {
        const row = existing.get(id);
        if (row?.group_json && row.live_until <= now && hints.get(id) && row.version === hints.get(id))
          allowed.set(id, JSON.parse(row.group_json));
        else unresolved.push(id);
      }
      if (unresolved.length === keys.length) throw err;
      if (unresolved.length) unavailable = unresolved;
    }
    for (const [i,id] of (accounts ? missing : []).entries()) {
      const group = decode(accounts[i], id);
      if (group?.tag !== 31) continue;
      const member = decode(accounts[i+missing.length], String(memberships[i]));
      const admitted = group.owner === viewer || (member?.tag === 33 &&
          member.group === id && member.to === viewer && member.status === 2);
      const version = await privateProfileVersion(group);
      // A verified policy change also invalidates other viewers' old snapshots.
      await db.prepare("UPDATE community_access SET generation=generation+1, valid_until=0 WHERE realm=? AND program=? AND group_id=? AND viewer<>? AND version<>? AND valid_until>0")
        .bind(realm,manifest.program,id,viewer,version).run();
      const prior = existing.get(id);
      const generation = prior?.generation || 0;
      await observeAccess(db,realm,viewer,id,version,admitted ? group : null,generation,now);
      if (admitted) allowed.set(id,group);
    }
  }
  const groups = await Promise.all(keys.filter(id=>allowed.has(id)).map(id=>{
    const g = allowed.get(id);
    return g.visibility === "private" ? currentProfile(db,realm,g,hash) : g;
  }));
  return {groups,...(unavailable ? {unavailable} : {})};
}
