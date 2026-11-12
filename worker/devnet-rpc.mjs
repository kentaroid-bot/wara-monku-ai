import { Connection } from "@solana/web3.js";
import { assertDevnet } from "../shared/protocol.mjs";

// The Solana public endpoint refuses requests from Workers' shared egress.
import { publicDevnetFallback as workerDevnetUrl } from "../shared/devnet.mjs";
export { workerDevnetUrl };

// Replay only an explicit rate-limit response, with the original RPC body
// (and therefore the identical transaction signature for sendTransaction).
async function fetchRpc(url, init) {
  const signal = AbortSignal.timeout(8000);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...init, redirect: "manual", signal });
    if (response.status !== 429 || attempt >= 3) return response;
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const requestedMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    const baseDelay = 1100 * (attempt + 1);
    const delay = Math.max(baseDelay, requestedMs || 0);
    if (delay > 5000) return response;
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

let cachedConn = null;
let cachedUrl = null;

export function workerConnection(env) {
  const url = env.DEVNET_RPC_URL || workerDevnetUrl;
  if (cachedConn && cachedUrl === url) return cachedConn;
  cachedUrl = url;
  cachedConn = new Connection(url, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: fetchRpc,
  });
  return cachedConn;
}

export async function requireFreshBlockhash(rpc, blockhash, fail) {
  let valid;
  try {
    await assertDevnet(rpc);
    ({ value: valid } = await rpc.isBlockhashValid(blockhash, { commitment: "confirmed" }));
  } catch {
    fail(503, "Devnetに接続できず、取引の有効期限を確認できませんでした。少し待ってからもう一度お試しください。");
  }
  if (!valid)
    fail(400, "この取引の有効期限が切れました。もう一度操作してください。");
}
