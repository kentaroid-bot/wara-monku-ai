import securityHeaders from "../shared/security-headers.cjs";
import bs58 from "bs58";
import { metadataAddress, METADATA_PROGRAM, decodeMetadata } from "../shared/token-metadata.mjs";
import { avatar } from "../shared/community-metadata.mjs";
import { mintFor, parseRow, pk, tok } from "../shared/protocol.mjs";
import manifest from "../shared/deployment.mjs";
import { workerConnection } from "./devnet-rpc.mjs";

const program = pk(manifest.program);
// Only immutable addresses are cached; public/private policy is always read live.
const groupsByMint = new Map();
const maxCachedGroups = 4096;
function rememberGroup(mint, group) {
  if (!groupsByMint.has(mint) && groupsByMint.size >= maxCachedGroups) groupsByMint.delete(groupsByMint.keys().next().value);
  groupsByMint.set(mint, group);
}

function reply(body, status = 200) {
  return Response.json(body, { status, headers: {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": status === 200 ? "public, max-age=0, must-revalidate" : "no-store",
    ...securityHeaders,
  } });
}

export async function communityMetadata(req, env, ctx, connection = workerConnection(env)) {
  if (req.method !== "GET") return reply({error:"GETを使用してください。"}, 405);
  const url = new URL(req.url);
  const address = url.pathname.match(/^\/api\/v3\/metadata\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/)?.[1];
  if (!address || bs58.decode(address).length !== 32) return reply({error:"Mintが不正です。"}, 400);
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(url.origin + "/.wara-cache/group-for-mint/" + address);
  try {
    const mint = pk(address);
    const account = await connection.getAccountInfo(mint, "confirmed");
    if (!account?.owner.equals(tok) || account.data.length !== 82 || account.data[44] !== 0 || account.data[45] !== 1 ||
        account.data.readUInt32LE(0) !== 1 || !account.data.subarray(4,36).equals(mint.toBuffer()))
      return reply({error:"このMintは見つかりません。"}, 404);
    // Older groups also derive their mint from the immutable group address.
    // Cache only immutable mint-to-group discovery. Re-read the live policy
    // on every response, including immediately after a public group is unlisted.
    let group = groupsByMint.get(address);
    const hit = !group && await cache?.match(cacheKey);
    if (hit) group = pk(await hit.text());
    if (!group || !mintFor(program,group).equals(mint)) {
      const candidates = await connection.getProgramAccounts(program, {commitment:"confirmed",
        filters:[{memcmp:{offset:0,bytes:bs58.encode(Uint8Array.of(31))}}], dataSlice:{offset:0,length:0}});
      group = candidates.find(r => mintFor(program,r.pubkey).equals(mint))?.pubkey;
      if (group && cache && ctx) ctx.waitUntil(cache.put(cacheKey, new Response(String(group), {
        headers:{"Cache-Control":"public, max-age=300"}
      })));
    }
    if (group && mintFor(program, group).equals(mint)) rememberGroup(address, group);
    const info = group && await connection.getAccountInfo(group, "confirmed");
    const row = info?.owner.equals(program) && parseRow(info.data, String(group));
    if (row?.tag !== 31) return reply({error:"コミュニティは見つかりません。"}, 404);
    const hidden = row.visibility === "private";
    let name = "WARA";
    if (!hidden) {
      // A group opened as unlisted keeps its original token name when listed.
      // Older groups without a registered Metaplex account keep the legacy display.
      const md = await connection.getAccountInfo(metadataAddress(mint), "confirmed");
      if (md && !md.owner.equals(METADATA_PROGRAM)) throw Error("metadata owner");
      name = md ? decodeMetadata(md.data).name : row.name + " WARA";
    }
    return reply({
      name, symbol:"WARA", image:avatar,
      description: hidden ? "Private Community WARA Token" : row.name + "のコミュニティで循環するWARAトークン",
      attributes: hidden ? [{trait_type:"Type", value:"Private"}] :
        [{trait_type:"Community",value:row.name},{trait_type:"Type",value:"Public"}],
    });
  } catch {
    return reply({error:"Devnetの照会を再試行してください。"}, 503);
  }
}
