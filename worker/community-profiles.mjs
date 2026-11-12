import { Buffer } from "buffer";
import manifest from "../shared/deployment.mjs";
import { assertDevnet } from "../shared/protocol.mjs";
import { addr, pk } from "../shared/protocol.mjs";
import { openPrivateProfile, privateProfileVersion } from "../shared/private-community.mjs";
import { address, decode } from "./shop-profiles.mjs";

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

export async function readCommunityProfiles(db, readers, realm, viewer, ids, hash, fail) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 32) fail(400, "コミュニティの指定を確認してください。");
  const keys = [...new Set(ids.map(id => address(id, fail)))];
  const memberships = keys.map(id => addr(program,"m3",id,viewer));
  const accounts = await readCommunityAccounts(readers,[...keys.map(pk),...memberships],fail);
  const groups = [];
  for (const [i,id] of keys.entries()) {
    const group = decode(accounts[i], id);
    const member = decode(accounts[i+keys.length], String(memberships[i]));
    if (group?.tag !== 31 || (group.owner !== viewer && !(member?.tag === 33 &&
        member.group === id && member.to === viewer && member.status === 2))) continue;
    if (group.visibility !== "private") { groups.push(group); continue; }
    groups.push(await currentProfile(db,realm,group,hash));
  }
  return {groups};
}
