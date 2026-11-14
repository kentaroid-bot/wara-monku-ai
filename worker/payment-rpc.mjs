// Each endpoint must prove its cluster before receiving signed bytes.
import { Connection } from "@solana/web3.js";
import { assertDevnet, DEVNET_GENESIS } from "../shared/protocol.mjs";
import { publicDevnetFallback, tatumDevnetUrl } from "../shared/devnet.mjs";

const backoffMs = [1100, 2200, 3300];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class Unavailable extends Error {
  constructor(message, {rateLimited = false, retryAfterMs = 0, definitelyRejected = false} = {}) {
    super(message);
    this.name = "Unavailable";
    this.rateLimited = rateLimited;
    this.retryAfterMs = retryAfterMs;
    this.definitelyRejected = definitelyRejected;
  }
}

function retryDelay(value) {
  if (!value) return backoffMs[0];
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(60000, Math.max(ms, backoffMs[0])) : backoffMs[0];
}

async function rpcFetch(url, init) {
  let response;
  try {
    response = await fetch(url, {...init, redirect:"manual", signal:AbortSignal.timeout(4500)});
  } catch {
    throw new Unavailable("Devnet RPC transport unavailable");
  }
  const error = (await response.clone().json().catch(() => null))?.error;
  const rateLimited = response.status === 429 || [-32029, -32005, 429].includes(error?.code);
  const refused = [401, 403, 404].includes(response.status) || [-32601, -16401].includes(error?.code);
  if (!rateLimited && !refused && response.status !== 408 && response.status < 500) return response;

  throw new Unavailable("Devnet RPC unavailable", {
    rateLimited,
    retryAfterMs: rateLimited ? retryDelay(response.headers.get("Retry-After")) : 0,
    // A transport failure or a bare gateway 5xx can follow a successful forward.
    definitelyRejected: rateLimited || refused,
  });
}

let config, pool;
export function paymentConnection(env) {
  const configuredPrimary = env.DEVNET_PAYMENT_RPC_URL || env.DEVNET_RPC_URL;
  const primary = configuredPrimary || publicDevnetFallback;
  const alternate = env.DEVNET_PAYMENT_FALLBACK_URL || (!configuredPrimary && tatumDevnetUrl);
  const urls = [...new Set([primary, alternate].filter(Boolean))];
  const key = JSON.stringify(urls);
  if (config !== key) {
    pool = urls.map(url => ({
      rpc: new Connection(url, {commitment:"confirmed", disableRetryOnRateLimit:true, fetch:rpcFetch}),
      until: 0,
      failure: null,
    }));
    config = key;
  }
  return verifiedPaymentRpc(pool);
}

async function invoke(rpc, method, args) {
  if (method === "getGenesisHash") return DEVNET_GENESIS;
  if (method === "getAccountInfo") return (await rpc.getAccountInfoAndContext(...args)).value;
  return rpc[method](...args);
}

function verifiedPaymentRpc(nodes) {
  let selected;
  async function call(method, args) {
    const now = Date.now();
    let candidates = [...nodes].sort((a, b) => Number(a.until > now) - Number(b.until > now) ||
      Number(b === selected) - Number(a === selected));
    let uncertainSend = false;
    for (let pass = 0; ; pass++) {
      for (const node of candidates) {
        if (node.failure?.rateLimited && node.until > Date.now()) continue;
        let verified = false;
        try {
          await assertDevnet(node.rpc);
          verified = true;
          const result = await invoke(node.rpc, method, args);
          node.until = 0;
          node.failure = null;
          selected = node;
          return result;
        } catch (error) {
          if (verified && !(error instanceof Unavailable)) {
            if (uncertainSend) throw new Unavailable("Devnet broadcast result unknown");
            throw error;
          }
          // Errors during identity checks cannot have broadcast this transaction.
          if (verified && method === "sendRawTransaction" && !error.definitelyRejected) uncertainSend = true;
          node.failure = error;
          node.until = Date.now() + (error.rateLimited ? error.retryAfterMs : 30000);
        }
      }

      candidates = candidates.filter(node => node.failure?.rateLimited);
      if (!candidates.length || pass === backoffMs.length) break;
      const earliest = Math.min(...candidates.map(node => node.until)) - Date.now();
      // A minute-long provider quota outlives our retry budget. Leave it cooling.
      if (earliest > backoffMs.slice(pass).reduce((sum, delay) => sum + delay, 0)) break;
      await wait(Math.max(backoffMs[pass], earliest));
    }
    throw new Unavailable("Devnet RPC nodes unavailable", {definitelyRejected: !uncertainSend});
  }
  const methods = ["getGenesisHash", "isBlockhashValid", "getMinimumBalanceForRentExemption",
    "getAccountInfo", "simulateTransaction", "sendRawTransaction"];
  return Object.fromEntries(methods.map(method => [method, (...args) => call(method, args)]));
}
