import bs58 from "bs58";
import { Buffer } from "buffer";
import { rpc, program } from "./network.mjs";
import { pk } from "./protocol.mjs";
export function entries(tx, sig, address, storeId = null) {
  if (!tx?.meta || tx.meta.err) return [];
  const out = [];
  for (const ix of tx.transaction.message.instructions) {
    if (
      String(ix.programId) !== String(program) ||
      !ix.data ||
      !Array.isArray(ix.accounts)
    )
      continue;
    const d = Buffer.from(bs58.decode(ix.data)),
      keys = ix.accounts.map(String),
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
    out.push({
      sig,
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
  const store = shopName(r.group, r.shop) || ("店舗 " + r.shop.slice(0, 5) + "…" + r.shop.slice(-5));
  const title = r.kusa
    ? r.incoming ? `${store}で ${r.n} INA の感謝を受け取りました` : `${store} に ${r.n} INA の感謝を贈りました`
    : r.incoming ? `${store}で ${r.n} WARA を受け取りました` : `${store} に ${r.n} WARA を支払いました`;
  const detail = r.kusa
    ? `${r.incoming ? "あなたの店" : "店"}に +${r.n * 90n} WARA ／ ${r.incoming ? "お客さん" : "あなた"}に +${r.n * 10n} WARA`
    : `発行元：${by(r.origin)?.name || "地域"}`;
  const time = r.time ? new Date(r.time * 1000).toLocaleString("ja-JP", {month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"Asia/Tokyo"}) + " JST · " : "";
  return `<li class="story"><span aria-hidden="true">${r.incoming ? "🌾" : "🌱"}</span>
    <div><strong>${h(title)}</strong><p>${h(detail)}</p><small>${h(time)}${h(by(r.group)?.name || "地域")} ·
    <a target="_blank" rel="noopener" href="https://explorer.solana.com/tx/${encodeURIComponent(r.sig)}?cluster=devnet">取引を確認 ↗</a></small></div></li>`;
}
// The wallet and shop share the same confirmed receipts as the warmth indicator.
export function paymentHistory(address, onPayment) {
  let cached = new Map();
  let pending;
  async function read() {
    const signatures = await rpc.getSignaturesForAddress(pk(address), { limit: 20 });
    const valid = signatures.filter(item => !item.err);
    const missing = valid.filter(item => !cached.has(item.signature));
    const transactions = missing.length ? await rpc.getParsedTransactions(
      missing.map(item => item.signature), { maxSupportedTransactionVersion: 0 },
    ) : [];
    missing.forEach(({ signature, blockTime }, i) => {
      const tx = transactions[i];
      if (!tx) return; // The RPC may still be indexing it.
      const rows = entries(tx, signature, address);
      for (const row of rows) row.time ??= blockTime;
      cached.set(signature, rows);
    });
    // Bound the cache to the same twenty signatures shown in the wallet.
    cached = new Map(valid.filter(item => cached.has(item.signature))
      .map(({ signature }) => [signature, cached.get(signature)]));
    const rows = [...cached.values()].flat();
    const latest = Math.max(0, ...rows.map(row => row.time || 0));
    if (latest) onPayment(latest * 1000);
    return { rows, indexing: cached.size < valid.length };
  }
  return () => pending ??= read().finally(() => { pending = null; });
}

export function showHistory(el, readHistory, storeId, h, by, shopName) {
  const section = document.createElement("section");
  section.innerHTML = '<div class="section-head"><h2>ありがとうの履歴</h2><small>直近の循環</small></div><ol class="stories"></ol><p role="status"></p><button type="button" class="secondary">履歴を更新</button>';
  el.append(section);
  const body = section.querySelector("ol"), status = section.querySelector('[role="status"]'),
    btn = section.querySelector("button");
  async function refresh() {
    btn.disabled = true;
    status.textContent = "直近20件の取引を確認しています…";
    try {
      const result = await readHistory();
      const rows = storeId ? result.rows.filter(row => row.incoming && row.group === storeId) : result.rows;
      body.innerHTML = rows.map(r => storyReceipt(r, h, by, shopName)).join("");
      status.textContent = rows.length ? "" : "直近20件に確定したお会計はありません。";
      if (result.indexing) status.textContent += " 索引処理中の取引があります。";
    } catch {
      status.textContent = "履歴を読み込めませんでした。時間をおいて更新してください。";
    } finally {
      btn.disabled = false;
    }
  }
  btn.onclick = refresh;
  refresh();
}
