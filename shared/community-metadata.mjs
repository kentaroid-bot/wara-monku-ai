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

export function communityOpening(program, owner, group, mode, invite, bytes, rent) {
  const meta = JSON.parse(bytes.toString("utf8"));
  if (meta.visibility === "private") {
    const sealed = meta.sealed;
    if (mode !== 1 || typeof sealed !== "string" || Buffer.from(sealed, "base64").length < 29 ||
        Buffer.from(sealed, "base64").toString("base64") !== sealed ||
        !bytes.equals(Buffer.from(JSON.stringify({ visibility: "private", sealed }))))
      throw Error("限定公開の招待設定を確認してください。");
  } else if (!bytes.equals(metadata(meta.name, meta.description, meta.category))) {
    throw Error("開設するコミュニティ情報が不正です。");
  }
  const fields = tokenFields(mintFor(program, group), meta);
  return [...createGroup(program, owner, group, mode, invite, bytes, rent),
    createCommunityMetadataInstruction(pk(program), pk(group), pk(owner), fields)];
}
