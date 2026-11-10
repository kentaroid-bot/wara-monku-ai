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
    ? r.incoming ? `${store}で ${r.n} kusa の感謝を受け取りました` : `${store} に ${r.n} kusa の感謝を贈りました`
    : r.incoming ? `${store}で ${r.n} WARA を受け取りました` : `${store} に ${r.n} WARA を支払いました`;
  const detail = r.kusa
    ? `${r.incoming ? "あなたの店" : "店"}に +${r.n * 90n} WARA ／ ${r.incoming ? "お客さん" : "あなた"}に +${r.n * 10n} WARA`
    : `発行元：${by(r.origin)?.name || "地域"}`;
  const time = r.time ? new Date(r.time * 1000).toLocaleString("ja-JP", {month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"Asia/Tokyo"}) + " JST · " : "";
  return `<li class="story"><span aria-hidden="true">${r.incoming ? "🌾" : "🌱"}</span>
    <div><strong>${h(title)}</strong><p>${h(detail)}</p><small>${h(time)}${h(by(r.group)?.name || "地域")} ·
    <a target="_blank" rel="noopener" href="https://explorer.solana.com/tx/${encodeURIComponent(r.sig)}?cluster=devnet">取引を確認 ↗</a></small></div></li>`;
}
export function showHistory(el, address, storeId, h, by, shopName) {
  const section = document.createElement("section");
  section.innerHTML = '<div class="section-head"><h2>ありがとうの履歴</h2><small>直近の循環</small></div><ol class="stories"></ol><p role="status"></p><button type="button" class="secondary">履歴を更新</button>';
  el.append(section);
  const body = section.querySelector("ol"), status = section.querySelector('[role="status"]'),
    btn = section.querySelector("button");
  async function refresh() {
    btn.disabled = true;
    status.textContent = "直近20件の取引を確認しています…";
    try {
      const list = await rpc.getSignaturesForAddress(pk(address), {
        limit: 20,
      });
      const valid = list.filter((x) => !x.err);
      const data = valid.length
        ? await rpc.getParsedTransactions(
            valid.map((x) => x.signature),
            { maxSupportedTransactionVersion: 0 },
          )
        : [];
      const rows = data.flatMap((t, i) =>
        entries(t, valid[i].signature, address, storeId),
      );
      body.innerHTML = rows.map(r => storyReceipt(r, h, by, shopName)).join("");
      status.textContent = rows.length ? "" : "直近20件に確定したお会計はありません。";
      if (data.some(t => !t)) status.textContent += " 索引処理中の取引があります。";
    } catch {
      status.textContent = "履歴を読み込めませんでした。時間をおいて更新してください。";
    } finally {
      btn.disabled = false;
    }
  }
  btn.onclick = refresh;
  refresh();
}
