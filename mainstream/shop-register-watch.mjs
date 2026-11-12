import { entries } from "./history.mjs";
import { pk } from "./protocol.mjs";

// Baseline raw signatures, not decoded history: delayed indexing of an old
// receipt must not look like a new payment. Keep missing new transactions for retry.
export async function registerReceipts(rpc, address, group) {
  const wallet = pk(address);
  const initial = await rpc.getSignaturesForAddress(wallet, { limit: 1 }, "confirmed");
  let head = initial[0]?.signature;
  const pending = new Map();
  return async function read() {
    const found = [];
    let before;
    do {
      const page = await rpc.getSignaturesForAddress(wallet, {
        limit: 20, ...(head ? { until: head } : {}), ...(before ? { before } : {}),
      }, "confirmed");
      // Some RPC adapters include the boundary; do not replay it.
      const boundary = page.findIndex(item => item.signature === head);
      found.push(...(boundary < 0 ? page : page.slice(0, boundary)));
      if (boundary >= 0 || page.length < 20) break;
      const next = page.at(-1).signature;
      if (next === before) throw Error("取引一覧の続きを取得できません。");
      before = next;
    } while (true);
    for (const item of found) if (!item.err && !pending.has(item.signature)) pending.set(item.signature, item);
    head = found[0]?.signature ?? head;
    for (const [signature] of [...pending].slice(0, 5)) {
      const tx = await rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) {
        // Retry without starving other receipts when this signature is not indexed yet.
        const item = pending.get(signature);
        pending.delete(signature);
        pending.set(signature, item);
        continue;
      }
      if (tx.transaction.signatures[0] !== signature) throw Error("取引署名が一致しません。");
      const rows = entries(tx, signature, address, group).filter(row => row.incoming && row.n > 0n);
      pending.delete(signature);
      if (rows.length) return rows;
    }
    return [];
  };
}

export function createRegisterWatch({
  rpc, intervalMs = 5000, timers = globalThis,
  navigation = globalThis.window, Observer = globalThis.MutationObserver,
  receipts = registerReceipts,
}) {
  let generation = 0, cleanup = () => {};
  function stop() { generation++; cleanup(); cleanup = () => {}; }
  async function start({ element, address, group, onPayment, onError = () => {} }) {
    stop();
    const turn = generation;
    let timer, observer;
    const current = () => turn === generation && element.isConnected;
    cleanup = () => {
      timers.clearTimeout(timer);
      observer?.disconnect();
      for (const event of ["pagehide", "popstate", "hashchange"]) navigation?.removeEventListener(event, stop);
    };
    for (const event of ["pagehide", "popstate", "hashchange"]) navigation?.addEventListener(event, stop);
    if (Observer && element.ownerDocument?.body) {
      observer = new Observer(() => { if (!element.isConnected) stop(); });
      observer.observe(element.ownerDocument.body, { childList: true, subtree: true });
    }
    let read;
    try { read = await receipts(rpc, address, group); }
    catch (error) { if (turn === generation) stop(); throw error; }
    if (!current()) { if (turn === generation) stop(); return false; }
    async function poll() {
      if (!current()) { if (turn === generation) stop(); return; }
      try {
        const rows = await read();
        if (!current()) { if (turn === generation) stop(); return; }
        if (rows.length) {
          stop();
          await onPayment(rows);
          return;
        }
      } catch (error) {
        if (current()) onError(error);
      }
      // Recursive timeout: never overlap slow RPC calls.
      if (current()) timer = timers.setTimeout(poll, intervalMs);
      else if (turn === generation) stop();
    }
    timer = timers.setTimeout(poll, intervalMs);
    return true;
  }
  return { start, stop };
}
