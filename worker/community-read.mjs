// Only repeat idempotent public account reads; admission and D1 decryption stay in the Worker.
import { Connection } from "@solana/web3.js";
import { assertDevnet, DEVNET_GENESIS } from "../shared/protocol.mjs";
import { workerDevnetUrl } from "./devnet-rpc.mjs";

import { tatumDevnetUrl } from "../shared/devnet.mjs";

const checked = new WeakSet();
async function verifyReader(reader) {
  if (checked.has(reader)) return;
  // The identity of the fixed public Devnet URL is shared across cold starts.
  // No user, RPC credential, account data or admission decision goes into this cache.
  const publicId = [workerDevnetUrl,tatumDevnetUrl].indexOf(reader.rpcEndpoint);
  const cache = publicId >= 0 && globalThis.caches?.default;
  const key = cache && new Request("https://wara.monku.ai/.wara-cache/devnet-genesis-v1/"+publicId);
  let hit;
  if (cache) try { hit = await cache.match(key); } catch {}
  if (hit?.headers.get("X-Wara-Genesis") !== DEVNET_GENESIS) {
    await assertDevnet(reader);
    if (cache) try {
      await cache.put(key,new Response(null,{headers:{"X-Wara-Genesis":DEVNET_GENESIS,"Cache-Control":"public, max-age=3600"}}));
    } catch {} // The verified live result still applies.
  }
  checked.add(reader);
}
let connections, config;
export function communityReaders(env) {
  const primary = env.DEVNET_RPC_URL || workerDevnetUrl;
  const alternate = env.DEVNET_READ_FALLBACK_URL || (!env.DEVNET_RPC_URL && tatumDevnetUrl);
  const urls = [...new Set([primary, alternate].filter(Boolean))];
  if (config !== JSON.stringify(urls)) {
    connections = urls.map(url => new Connection(url, {commitment:"confirmed", disableRetryOnRateLimit:true,
      fetch:(target,init)=>fetch(target,{...init,redirect:"manual",signal:AbortSignal.timeout(3500)})}));
    config = JSON.stringify(urls);
  }
  return connections;
}

export async function readCommunityAccounts(readers, keys, fail) {
  // Start with the primary. Recheck genesis on each connection (cached only after success).
  // A cold shared node may rate-limit the second call immediately after the genesis lookup.
  const deadline = Date.now()+8500;
  for (let pass=0; pass<3 && Date.now()<deadline; pass++) {
    if (pass) await new Promise(resolve=>setTimeout(resolve,pass===1 ? 1300 : 2600));
    for (const reader of readers) {
      if (Date.now() >= deadline) break;
      try {
        await verifyReader(reader);
        return await reader.getMultipleAccountsInfo(keys,"confirmed");
      } catch { /* Try the next configured Devnet reader; never trust client-supplied membership. */ }
    }
  }
  fail(503,"Devnetからコミュニティ一覧を取得できませんでした。少し待ってから再試行してください。");
}
