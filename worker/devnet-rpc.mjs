import { Connection } from "@solana/web3.js";
import { assertDevnet } from "../app/protocol.mjs";

// The Solana public endpoint refuses requests from Workers' shared egress.
export const workerDevnetUrl = "https://solana-devnet.api.onfinality.io/public";

// Replay only an explicit rate-limit response, with the original RPC body
// (and therefore the identical transaction signature for sendTransaction).
async function fetchRpc(url, init) {
  const signal = AbortSignal.timeout(8000);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...init, redirect: "manual", signal });
    if (response.status !== 429 || attempt >= 2) return response;
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const requestedMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    const delay = Math.max(1000 * (attempt + 1), requestedMs || 0);
    if (delay > 3000) return response;
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

export function workerConnection(env) {
  return new Connection(env.DEVNET_RPC_URL || workerDevnetUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: fetchRpc,
  });
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
