import { Buffer } from "buffer";
import { metadata, pk } from "./protocol.mjs";

// This key opens display text only; it cannot sign an invitation transaction.
export async function openPrivateProfile(group, rawKey) {
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const bytes = Buffer.from(group.sealed, "base64");
  const plain = await crypto.subtle.decrypt({name:"AES-GCM", iv:bytes.subarray(0,12),
    additionalData:pk(group.id).toBytes()}, key, bytes.subarray(12));
  const {name, description, category} = JSON.parse(Buffer.from(plain).toString("utf8"));
  if (typeof name !== "string" || typeof description !== "string") throw Error("Invalid profile");
  return JSON.parse(metadata(name, description, category).toString("utf8"));
}

export async function privateProfileVersion(group) {
  const bytes = Buffer.from(JSON.stringify([group.id, group.owner, group.mode, group.invite, group.sealed]));
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
}
