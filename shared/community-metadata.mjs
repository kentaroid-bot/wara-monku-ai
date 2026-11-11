import { TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { Buffer } from "buffer";
import { createGroup, mintFor, pk, metadata } from "../mainstream/protocol.mjs";
import { createCommunityMetadataInstruction } from "../scripts/token-metadata.mjs";

const origin = "https://wara.monku.ai";
export const avatar = origin + "/assets/wara-avatar.png";

export function tokenFields(mint, group) {
  const name = group.visibility === "private" ? "WARA" : group.name + " WARA";
  if ((group.visibility !== "private" && !group.name) || name.includes("\0") || Buffer.byteLength(name) > 32)
    throw Error("公開コミュニティの名称は27バイト以内（日本語は目安9文字）で入力してください。");
  return { name, symbol: "WARA", uri: origin + "/api/v3/metadata/" + mint + ".json" };
}

function validateDisplay(bytes) {
  if (!bytes.length || bytes.length > 400) throw Error("コミュニティ情報のサイズが不正です。");
  const meta = JSON.parse(bytes.toString("utf8"));
  if (meta.visibility === "private") {
    const sealed = meta.sealed;
    if (typeof sealed !== "string" || Buffer.from(sealed, "base64").length < 29 ||
        Buffer.from(sealed, "base64").toString("base64") !== sealed ||
        !bytes.equals(Buffer.from(JSON.stringify({ visibility: "private", sealed }))))
      throw Error("限定公開の招待設定を確認してください。");
  } else if (!bytes.equals(metadata(meta.name, meta.description, meta.category))) {
    throw Error("開設するコミュニティ情報が不正です。");
  }
  return meta;
}

export function communityOpening(program, owner, group, mode, invite, bytes, rent) {
  const meta = validateDisplay(bytes);
  const fields = tokenFields(mintFor(program, group), meta);
  return [...createGroup(program, owner, group, mode, invite, bytes, rent),
    createCommunityMetadataInstruction(pk(program), pk(group), pk(owner), fields)];
}

// Op 17 can resize the existing group with rent from its administrator. It
// never receives a mint, metadata PDA, membership record or token account.
export function communityUpdate(program, owner, group, oldMode, oldInvite, mode, invite, bytes) {
  validateDisplay(bytes);
  if (![oldMode, mode].every(n => Number.isInteger(n) && n >= 0 && n <= 2))
    throw Error("参加方式が不正です。");
  return new TransactionInstruction({programId:pk(program), keys:[
    {pubkey:pk(owner),isSigner:true,isWritable:true}, {pubkey:pk(group),isSigner:false,isWritable:true},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false}
  ], data:Buffer.concat([Buffer.from([17, oldMode]),pk(oldInvite).toBuffer(),Buffer.from([mode]),pk(invite).toBuffer(),bytes])});
}
