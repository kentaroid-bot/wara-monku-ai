import { Buffer } from "buffer";
import manifest from "../deployments/devnet.json" with {type:"json"};
import { assertDevnet } from "../app/protocol.mjs";
import { addr, pk } from "../mainstream/protocol.mjs";
import { openPrivateProfile, privateProfileVersion } from "../shared/private-community.mjs";
import { address, decode } from "./shop-profiles.mjs";

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

export async function saveCommunityProfile(db, rpc, realm, viewer, body, hash, fail) {
  const id = address(body.group, fail);
  await assertDevnet(rpc);
  const group = decode(await rpc.getAccountInfo(pk(id), "confirmed"), id);
  if (group?.tag !== 31 || group.owner !== viewer) fail(403, "管理者だけがコミュニティ情報を同期できます。");
  if (group.visibility !== "private" || body.sealed !== group.sealed || body.invite !== group.invite)
    fail(409, "コミュニティの設定が更新されています。画面を更新してください。");
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
  return {group:{...group,...profile,unlocked:true,joined:true}};
}

export async function readCommunityProfiles(db, rpc, realm, viewer, ids, hash, fail) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 32) fail(400, "コミュニティの指定を確認してください。");
  const keys = [...new Set(ids.map(id => address(id, fail)))];
  const memberships = keys.map(id => addr(program,"m3",id,viewer));
  await assertDevnet(rpc);
  const accounts = await rpc.getMultipleAccountsInfo([...keys.map(pk),...memberships], "confirmed");
  const groups = [];
  for (const [i,id] of keys.entries()) {
    const group = decode(accounts[i], id);
    const member = decode(accounts[i+keys.length], String(memberships[i]));
    if (group?.tag !== 31 || (group.owner !== viewer && !(member?.tag === 33 &&
        member.group === id && member.to === viewer && member.status === 2))) continue;
    if (group.visibility !== "private") { groups.push(group); continue; }
    const version = await privateProfileVersion(group);
    const row = await db.prepare("SELECT sealed_profile FROM private_community_profiles WHERE realm=? AND group_id=? AND version=?")
      .bind(realm,id,version).first();
    const profile = row ? await protect(hash,id,version,row.sealed_profile,true) : null;
    groups.push({...group,...profile,joined:true,unlocked:Boolean(profile)});
  }
  return {groups};
}
