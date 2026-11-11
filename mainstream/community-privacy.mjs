import { Buffer } from "buffer";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { metadata, pk } from "./protocol.mjs";

export function codeKey(code) {
  try { return Keypair.fromSeed(bs58.decode(code.trim())); }
  catch { throw Error("招待コードの形式が違います。"); }
}

const inviteKey = (group, wallet) => "wara.private." + wallet + "." + group;
export const pendingInvite = group => "wara.pending-invite." + group;
export const storedInvite = (group, wallet) => localStorage.getItem(inviteKey(group, wallet));
export function rememberInvite(group, wallet, code) {
  localStorage.setItem(inviteKey(group, wallet), code);
}

export function invitationUrl(group, code) {
  return "https://wara.monku.ai/#/join?" + new URLSearchParams({ g: group, code });
}

export function parseInvitation(hash) {
  if (!hash.startsWith("#/join?")) return null;
  const params = new URLSearchParams(hash.slice(7));
  const group = params.get("g"), code = params.get("code");
  if (!group || String(pk(group)) !== group) throw Error("招待先が不正です。");
  codeKey(code);
  return { group, code };
}

async function displayKey(code) {
  // Domain separation from the Ed25519 invitation signing key.
  const raw = await crypto.subtle.digest("SHA-256", Buffer.concat([Buffer.from("WARA private display v1"), bs58.decode(code)]));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt","decrypt"]);
}

export async function privateMetadata(name, description, category, code, group) {
  const bytes = metadata(name, description, category);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name:"AES-GCM", iv, additionalData:pk(group).toBytes() }, await displayKey(code), bytes);
  const sealed = Buffer.concat([iv, new Uint8Array(encrypted)]).toString("base64");
  const envelope = Buffer.from(JSON.stringify({visibility:"private", sealed}));
  if (envelope.length > 400) throw Error("限定公開の名称・説明をもう少し短くしてください。");
  return envelope;
}

export async function privateGroupView(group, wallet, rows) {
  const member = group.owner === wallet || rows.some(r => r.tag === 33 && r.group === group.id && r.to === wallet && r.status === 2);
  const pending = sessionStorage.getItem(pendingInvite(group.id));
  const code = storedInvite(group.id, wallet) || pending;
  if (code) {
    try {
      if (String(codeKey(code).publicKey) === group.invite) {
        const bytes = Buffer.from(group.sealed, "base64");
        const plain = await crypto.subtle.decrypt({ name:"AES-GCM", iv:bytes.subarray(0,12),
          additionalData:pk(group.id).toBytes() }, await displayKey(code), bytes.subarray(12));
        const {name, description, category} = JSON.parse(Buffer.from(plain).toString("utf8"));
        if (member && pending === code) {
          rememberInvite(group.id, wallet, code);
          sessionStorage.removeItem(pendingInvite(group.id));
        }
        return { ...group, name, description, category, joined:member };
      }
    } catch { /* A stale invitation cannot unlock this group. */ }
  }
  return member ? { ...group, joined:true } : null;
}
