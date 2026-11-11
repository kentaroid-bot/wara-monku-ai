import bs58 from "bs58";
import { avatar } from "../shared/community-metadata.mjs";
import { mintFor, parseRow, pk, tok } from "../mainstream/protocol.mjs";
import manifest from "../deployments/devnet.json" with { type: "json" };
import { workerConnection } from "./devnet-rpc.mjs";

const program = pk(manifest.program);

function reply(body, status = 200) {
  return Response.json(body, { status, headers: {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}

export async function communityMetadata(req, env, ctx, connection = workerConnection(env)) {
  if (req.method !== "GET") return reply({error:"GETを使用してください。"}, 405);
  const url = new URL(req.url);
  const address = url.pathname.match(/^\/api\/v3\/metadata\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/)?.[1];
  if (!address || bs58.decode(address).length !== 32) return reply({error:"Mintが不正です。"}, 400);
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(url.origin + url.pathname);
  try {
    const hit = await cache?.match(cacheKey);
    if (hit) return hit;
    const mint = pk(address);
    const account = await connection.getAccountInfo(mint, "confirmed");
    if (!account?.owner.equals(tok) || account.data.length !== 82 || account.data[44] !== 0 || account.data[45] !== 1 ||
        account.data.readUInt32LE(0) !== 1 || !account.data.subarray(4,36).equals(mint.toBuffer()))
      return reply({error:"このMintは見つかりません。"}, 404);
    // Older groups also derive their mint from the immutable group address.
    const candidates = await connection.getProgramAccounts(program, {commitment:"confirmed",
      filters:[{memcmp:{offset:0,bytes:bs58.encode(Uint8Array.of(31))}}], dataSlice:{offset:0,length:0}});
    const group = candidates.find(row => mintFor(program,row.pubkey).equals(mint));
    const info = group && await connection.getAccountInfo(group.pubkey, "confirmed");
    const row = info?.owner.equals(program) && parseRow(info.data, String(group.pubkey));
    if (row?.tag !== 31) return reply({error:"コミュニティは見つかりません。"}, 404);
    const hidden = row.visibility === "private";
    const response = reply({
      name: hidden ? "WARA" : row.name + " WARA", symbol:"WARA", image:avatar,
      description: hidden ? "Private Community WARA Token" : row.name + "のコミュニティで循環するWARAトークン",
      attributes: hidden ? [{trait_type:"Type", value:"Private"}] :
        [{trait_type:"Community",value:row.name},{trait_type:"Type",value:"Public"}],
    });
    if (cache && ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch {
    return reply({error:"Devnetの照会を再試行してください。"}, 503);
  }
}
