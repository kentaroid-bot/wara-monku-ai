// Only the payment path fails over. Never change the signed message, blockhash
// or transaction ID. Each RPC must prove its own cluster before it sees a tx.
import { Connection } from "@solana/web3.js";
import { assertDevnet, DEVNET_GENESIS } from "../shared/protocol.mjs";
import { workerConnection, workerDevnetUrl } from "./devnet-rpc.mjs";

const publicAlternate = "https://solana-devnet.gateway.tatum.io";
class Unavailable extends Error {}
function retryable(error) {
  return error instanceof Unavailable || transientCodes.includes(error?.code);
}
const transientCodes = [-32005,-32029,-32601,429];
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function rpcFetch(url, init) {
  const sharedBackup = new URL(url).origin === publicAlternate;
  for (let attempt=0;;attempt++) {
    let response;
    try { response = await fetch(url,{...init, redirect:"manual",signal:AbortSignal.timeout(4500)}); }
    catch { throw new Unavailable("Devnet RPC transport unavailable"); }
    // Some gateways return a JSON-RPC error under HTTP 200. web3.js would
    // otherwise turn this into zero rent or a transaction-rejection error.
    const code = response.ok ? (await response.clone().json().catch(()=>null))?.error?.code : null;
    const limited = response.status === 429 || code === -32029 || code === 429;
    if (!limited && !transientCodes.includes(code) && ![401,403,404,408].includes(response.status) && response.status<500)
      return response;
    const retry = response.headers.get("Retry-After");
    const delay = !retry ? 1250 : /^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now();
    await response.body?.cancel();
    if (sharedBackup && limited && !attempt && Number.isFinite(delay) && delay<=3000) {
      await wait(Math.max(1250,delay));
      continue;
    }
    throw new Unavailable("Devnet RPC unavailable");
  }
}

let config, pool;
export function paymentConnection(env) {
  const primary = env.DEVNET_RPC_URL || workerDevnetUrl;
  const alternate = env.DEVNET_PAYMENT_FALLBACK_URL || (!env.DEVNET_RPC_URL && publicAlternate);
  const urls = [...new Set([primary,alternate].filter(Boolean))];
  const key = JSON.stringify(urls);
  if (config !== key) {
    pool = urls.map(url=>({rpc:urls.length === 1 ? workerConnection(env) : new Connection(url,{commitment:"confirmed",disableRetryOnRateLimit:true,fetch:rpcFetch}),until:0}));
    config = key;
  }
  return verifiedPaymentRpc(pool);
}

function verifiedPaymentRpc(nodes) {
  let selected;
  async function call(method, args) {
    const now = Date.now();
    // A failure on one shared endpoint should not slow down every subsequent
    // call in this payment or every payment in a warm Worker.
    const ordered = [...nodes].sort((a,b)=>Number(a.until>now)-Number(b.until>now) ||
      Number(b===selected)-Number(a===selected));
    let failure;
    for (const node of ordered) {
      try { await assertDevnet(node.rpc); }
      catch {
        node.until = now+30000;
        failure = new Unavailable("Devnet RPC identity unavailable");
        continue;
      }
      try {
        const result = method === "getGenesisHash" ? DEVNET_GENESIS :
          method === "getAccountInfo" ? (await node.rpc.getAccountInfoAndContext(...args)).value :
          await node.rpc[method](...args);
        node.until=0;
        selected=node;
        return result;
      } catch (error) {
        if (!retryable(error)) throw error; // A chain rejection is authoritative.
        node.until=now+30000;
        failure=error;
      }
    }
    throw failure;
  }
  return Object.fromEntries(["getGenesisHash","isBlockhashValid","getMinimumBalanceForRentExemption",
    "getAccountInfo","simulateTransaction","sendRawTransaction"].map(method=>[method,(...args)=>call(method,args)]));
}
