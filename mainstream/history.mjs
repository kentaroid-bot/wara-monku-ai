import { memoProgram, readPaymentMemo, reactions } from "../shared/payment-memo.mjs";
import { Connection } from "@solana/web3.js";
import { Buffer } from "buffer";
import { rpc, program } from "./network.mjs";
import { pk } from "./protocol.mjs";
import { publicDevnetFallback } from "../shared/devnet.mjs";
export function entries(tx, sig, address, storeId = null) {
  if (!tx?.meta || tx.meta.err) return [];
  const out = [];
  const message = tx.transaction.message;
  const accounts = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const instructions = message.compiledInstructions;
  for (const [index, ix] of instructions.entries()) {
    if (!accounts.get(ix.programIdIndex)?.equals(program)) continue;
    const d = Buffer.from(ix.data),
      keys = ix.accountKeyIndexes.map(index => String(accounts.get(index))),
      k = d[0] === 14,
      w = d[0] === 15;
    if ((!k && !w) || d.length !== (k ? 25 : 9)) continue;
    const [payer, group] = keys,
      shop = keys[k ? 2 : 3];
    if (
      storeId
        ? shop !== address || group !== storeId
        : payer !== address && shop !== address
    )
      continue;
    const n = d.readBigUInt64LE(1);
    const previous = index > 0 && instructions[index - 1];
    const memo = previous && accounts.get(previous.programIdIndex)?.equals(memoProgram) &&
      previous.accountKeyIndexes.length === 0 && readPaymentMemo(previous.data);
    out.push({
      ...(memo ? {memo} : {}),
      sig,
      payerSignature: tx.transaction.signatures?.[ix.accountKeyIndexes[0]],
      group,
      origin: k ? group : keys[2],
      payer,
      shop,
      n,
      kusa: k,
      incoming: address === shop,
      time: tx.blockTime,
    });
  }
  return out;
}
export function storyReceipt(r, h, by, shopName) {
  const store = shopName(r.group, r.shop) || ("受け取り窓口 " + r.shop.slice(0, 5) + "…" + r.shop.slice(-5));
  const title = r.kusa
    ? r.incoming ? `${store}で ${r.n} iine の感謝を受け取りました` : `${store} に ${r.n} iine の感謝を贈りました`
    : r.incoming ? `${store}で ${r.n} WARA を受け取りました` : `${store} に ${r.n} WARA を贈りました`;
  const reaction = reactions.includes(r.memo);
  const detail = r.kusa
    ? `${r.incoming ? "あなた" : "相手"}に +${r.n * 90n} WARA ／ ${r.incoming ? "贈る人" : "あなた"}に +${r.n * 10n} WARA`
    : `発行元：${by(r.origin)?.name || "地域"}`;
  const time = r.time ? new Date(r.time * 1000).toLocaleString("ja-JP", {month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"Asia/Tokyo"}) + " JST · " : "";
  return `<li class="story"><span aria-hidden="true">${r.incoming ? "🌾" : "🌱"}</span>
    <div><strong>${h(title)}</strong>${r.memo ? `<p class="receipt-memo">${reaction ? h(r.memo) : `💬「${h(r.memo)}」`}</p>` : ""}${r.note ? `<p class="receipt-memo">ひとこと「${h(r.note)}」</p>` : ""}<p>${h(detail)}</p><small>${h(time)}${h(by(r.group)?.name || "地域")} ·
    <a target="_blank" rel="noopener" href="https://explorer.solana.com/tx/${encodeURIComponent(r.sig)}?cluster=devnet">取引を確認 ↗</a></small></div></li>`;
}
// The wallet and shop share the same confirmed receipts as the warmth indicator.
const readOptions = { commitment: "confirmed", disableRetryOnRateLimit: true };
const historyNodes = [new Connection(rpc.rpcEndpoint, readOptions), new Connection(publicDevnetFallback, readOptions)];
const detailsPerRead = 5;
const cooldownMs = 60_000;
const isRateLimit = error => /\b429\b|too many requests/i.test(error?.message);

export function paymentHistory(address, onPayment, [primary, fallback] = historyNodes) {
  const wallet = pk(address);
  let cache = new Map();
  let attempt = 0;
  let primaryRetryAfter = 0;
  let retryAfter = 0;
  let pending;

  async function request(method, ...args) {
    if (fallback && Date.now() < primaryRetryAfter) return fallback[method](...args);
    try {
      return await primary[method](...args);
    } catch (error) {
      if (!fallback || !isRateLimit(error)) throw error;
      primaryRetryAfter = Date.now() + cooldownMs;
      return fallback[method](...args);
    }
  }

  function snapshot(incomplete = false) {
    const rows = [];
    for (const item of cache.values()) {
      if (item.rows) rows.push(...item.rows);
      else incomplete = true;
    }
    const latest = Math.max(0, ...rows.map(row => row.time || 0));
    if (latest) onPayment(latest * 1000);
    return { rows, indexing: incomplete };
  }

  function rateLimited(error) {
    if (!isRateLimit(error)) return false;
    retryAfter = Date.now() + cooldownMs;
    return true;
  }

  async function read() {
    if (Date.now() < retryAfter) return snapshot(true);
    let signatures;
    try {
      signatures = await request("getSignaturesForAddress", wallet, { limit: 20 }, "confirmed");
    } catch (error) {
      rateLimited(error);
      return snapshot(true);
    }
    const valid = signatures.filter(item => !item.err);
    cache = new Map(valid.map(({ signature }) => [signature, cache.get(signature) ?? { attempt: 0 }]));
    // Newest untried signatures first. A missing or unreadable receipt must not
    // occupy one of the first five slots on every subsequent refresh.
    const missing = valid.filter(item => !cache.get(item.signature).rows)
      .sort((a, b) => cache.get(a.signature).attempt - cache.get(b.signature).attempt);
    for (const { signature, blockTime } of missing.slice(0, detailsPerRead)) {
      const item = cache.get(signature);
      item.attempt = ++attempt;
      try {
        const tx = await request("getTransaction", signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx?.meta || tx.transaction.signatures[0] !== signature) continue;
        const rows = entries(tx, signature, address);
        for (const row of rows) row.time ??= blockTime;
        item.rows = rows;
      } catch (error) {
        if (rateLimited(error)) break;
      }
    }
    return snapshot();
  }
  return () => pending ??= read().finally(() => { pending = null; });
}

export function showHistory(el, readHistory, storeId, h, by, shopName, profiles) {
  const section = document.createElement("section");
  section.dataset.paymentHistory = "";
  section.innerHTML = '<div class="section-head"><h2>ありがとうの履歴</h2><small>直近の循環</small></div><ol class="stories"></ol><p role="status"></p><button type="button" class="secondary">履歴を更新</button>';
  el.append(section);
  const body = section.querySelector("ol"), status = section.querySelector('[role="status"]'),
    btn = section.querySelector("button");
  async function refresh(manual = false) {
    btn.disabled = true;
    status.textContent = "直近20件の取引を確認しています…";
    try {
      const result = await readHistory();
      const rows = storeId ? result.rows.filter(row => row.incoming && row.group === storeId) : result.rows;
      body.innerHTML = rows.map(r => storyReceipt(r, h, by, shopName)).join("");
      status.textContent = result.indexing ? "最新の取引を一部照会中です。しばらくしてから続きを確認できます。" :
        rows.length ? "" : "直近20件に確定した贈りものはありません。";
      if (profiles?.supportsNotes) {
        const incoming = rows.filter(r=>r.incoming && r.payerSignature);
        const receipts = [...new Map(incoming.map(r=>[r.sig,{sig:r.sig,payerSignature:r.payerSignature}])).values()];
        if (!receipts.length) return;
        if (!profiles.canReadNotes() && !manual) {
          status.textContent += " ひとことを見るには「履歴を更新」で財布を確認してください。";
          return;
        }
        try {
          const {notes} = await profiles.readNotes(receipts);
          const texts = new Map(notes.map(n=>[n.sig,n.note]));
          const rendered = new Set();
          body.innerHTML = rows.map(row=>{
            const note = row.incoming && !rendered.has(row.sig) && texts.get(row.sig);
            if (note) rendered.add(row.sig);
            return storyReceipt({...row,note},h,by,shopName);
          }).join("");
        } catch {
          status.textContent += " ひとことを取得できません。「履歴を更新」で再試行できます。";
        }
      }
    } catch {
      status.textContent = "履歴を読み込めませんでした。時間をおいて更新してください。";
    } finally {
      btn.disabled = false;
    }
  }
  section.addEventListener("refresh-history", () => refresh());
  btn.onclick = () => refresh(true);
  refresh();
}
