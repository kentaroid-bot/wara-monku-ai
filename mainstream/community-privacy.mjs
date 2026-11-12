import { inviteKey, privateInviteKey, pendingInvite, sessionInviteKey } from "./storage-keys.mjs";
import { Buffer } from "buffer";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { metadata, pk } from "./protocol.mjs";
import { openPrivateProfile, privateProfileVersion } from "../shared/private-community.mjs";

export function codeKey(code) {
  try { return Keypair.fromSeed(bs58.decode(code.trim())); }
  catch { throw Error("招待コードの形式が違います。"); }
}

export { pendingInvite } from "./storage-keys.mjs";
export function currentInvite(group, wallet) {
  // Match the on-chain key, not the last attempted transaction. A declined
  // signature or an ambiguous confirmation must not destroy the active link.
  const prefix = inviteKey(group.id, wallet);
  const candidates = [sessionStorage.getItem(pendingInvite(group.id)), localStorage.getItem(privateInviteKey(group.id, wallet, group.invite)),
    localStorage.getItem(prefix), sessionStorage.getItem(sessionInviteKey(group.id))];
  return candidates.find(code => {
    try { return code && String(codeKey(code).publicKey) === group.invite; } catch { return false; }
  }) || null;
}
export function rememberInvite(group, wallet, code) {
  localStorage.setItem(privateInviteKey(group, wallet, codeKey(code).publicKey), code);
}

export function invitationUrl(group, code) {
  return (globalThis.location?.origin || "https://wara.monku.ai") + "/#/join?" + new URLSearchParams({ g: group, code });
}

export function parseInvitation(hash) {
  if (!hash.startsWith("#/join?")) return null;
  const params = new URLSearchParams(hash.slice(7));
  const group = params.get("g"), code = params.get("code");
  if (!group || String(pk(group)) !== group) throw Error("招待先が不正です。");
  codeKey(code);
  return { group, code };
}

export async function displayKeyBytes(code) {
  // Domain separation from the Ed25519 invitation signing key.
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.concat([Buffer.from("WARA private display v1"), bs58.decode(code)])));
}

export async function privateMetadata(name, description, category, code, group) {
  const bytes = metadata(name, description, category);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", await displayKeyBytes(code), "AES-GCM", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name:"AES-GCM", iv, additionalData:pk(group).toBytes() }, key, bytes);
  const sealed = Buffer.concat([iv, new Uint8Array(encrypted)]).toString("base64");
  const envelope = Buffer.from(JSON.stringify({visibility:"private", sealed}));
  if (envelope.length > 400) throw Error("限定公開の名称・説明をもう少し短くしてください。");
  return envelope;
}

export async function privateGroupView(group, wallet, rows) {
  const member = group.joined === true || group.owner === wallet || rows.some(r => r.tag === 33 && r.group === group.id && r.to === wallet && r.status === 2);
  const pending = sessionStorage.getItem(pendingInvite(group.id));
  const code = currentInvite(group, wallet);
  if (code) {
    try {
      const {name, description, category} = await openPrivateProfile(group, await displayKeyBytes(code));
      if (member && pending === code) {
        rememberInvite(group.id, wallet, code);
        sessionStorage.removeItem(pendingInvite(group.id));
      }
      return { ...group, name:group.nameRevision ? group.name : name, description, category, unlocked:true, joined:member };
    } catch { /* A stale invitation cannot unlock this group. */ }
  }
  return member ? { ...group, joined:true } : null;
}

// Called on every wallet/directory/detail load. Synced plaintext is kept only
// in this view, never in browser storage or the public on-chain row cache.
export async function syncPrivateGroups(groups, wallet, rows, api, force = false) {
  const synced = new Map();
  const failed = new Set();
  let error = "";
  const retryMessage = "コミュニティの最新情報を取得できません。「更新」で再試行できます。参加済みの方は招待リンク不要です。";
  const candidates = groups.filter(g => g.visibility === "private");
  if (api) for (let i=0; i<candidates.length; i+=32) {
    try {
      const chunk = candidates.slice(i,i+32);
      const result = await api("community-profiles", {groups:chunk.map(g=>g.id),
        versions:await Promise.all(chunk.map(privateProfileVersion)), ...(force ? {force:true} : {})});
      if (result.unavailable?.length) {
        result.unavailable.forEach(id=>failed.add(id));
        error = retryMessage;
      }
      for (let group of result.groups) {
        if (group.visibility === "private" && !group.unlocked && group.owner === wallet) {
          const code = currentInvite(group, wallet);
          if (code) {
            try {
              ({group} = await api("community-save", {group:group.id, sealed:group.sealed, invite:group.invite,
                displayKey:Buffer.from(await displayKeyBytes(code)).toString("base64")}));
            } catch { error = "コミュニティ情報の同期が未完了です。「更新」で再試行できます。"; }
          }
        }
        synced.set(group.id, group);
      }
    } catch {
      for (const g of candidates.slice(i,i+32)) failed.add(g.id);
      error = retryMessage;
    }
  }
  const views = await Promise.all(groups.map(async original => {
    const group = synced.get(original.id) || original;
    if (group.visibility !== "private") return group;
    if (group.unlocked) {
      const code = currentInvite(group, wallet);
      if (code && sessionStorage.getItem(pendingInvite(group.id)) === code) {
        rememberInvite(group.id, wallet, code);
        sessionStorage.removeItem(pendingInvite(group.id));
      }
      return group;
    }
    const denied = api && !failed.has(group.id) && !synced.has(group.id);
    if (denied && (!sessionStorage.getItem(pendingInvite(group.id)) ||
        rows.some(r=>r.tag===33 && r.group===group.id && r.to===wallet && r.status===4))) return null;
    const view = await privateGroupView(group, wallet, denied ? [] : rows) || (group.joined ? group : null);
    if (failed.has(group.id) && view && (view.joined || !sessionStorage.getItem(pendingInvite(group.id))))
      return {...group, name:"限定公開コミュニティ（名称未確認）", joined:view.joined, nameUnavailable:true};
    if (api && view?.joined && !view.unlocked && !view.nameRevision && !error)
      error = "コミュニティ情報の同期を待っています。管理者が情報を同期した後、「更新」で確認できます。";
    return view;
  }));
  return {groups:views.filter(Boolean), communitySyncError:error};
}

// Limited groups need a display key in every mode. Only mode 1 uses it as
// a co-signer. Generate a fresh capability at every policy boundary so an
// old open link never acquires invitation rights when entry is tightened.
export async function makePolicy({visibility, mode, name, description, category}, group, owner, generateCode) {
  if (!["public","private"].includes(visibility) || ![0,1,2].includes(mode)) throw Error("公開範囲と参加方式を確認してください。");
  const code = visibility === "private" || mode === 1 ? generateCode() : null;
  const invite = code ? codeKey(code).publicKey : pk(owner);
  const bytes = visibility === "private" ? await privateMetadata(name, description, category, code, group)
    : metadata(name, description, category);
  return {mode, invite, bytes, code};
}
