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
export function showHistory(el, address, storeId, h, by) {
  const details = document.createElement("details");
  details.innerHTML =
    '<summary>最近の確定したお会計</summary><p>直近20件のウォレット取引から確認します。</p><button type="button">履歴を更新</button><div></div>';
  el.append(details);
  const body = details.querySelector("div"),
    btn = details.querySelector("button");
  async function refresh() {
    btn.disabled = true;
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
      body.innerHTML =
        rows
          .map(
            (r) =>
              "<p>" +
              h(by(r.group)?.name || "地域") +
              " · " +
              (r.kusa
                ? r.n +
                  " Kusa（店 " +
                  r.n * 90n +
                  " / 客 " +
                  r.n * 10n +
                  " WARA）"
                : r.n + " WARA・発行元 " + h(by(r.origin)?.name || "地域")) +
              " · " +
              (r.incoming ? "受取" : "支払") +
              ' <a target="_blank" rel="noopener" href="https://explorer.solana.com/tx/' +
              h(r.sig) +
              '?cluster=devnet">取引</a></p>',
          )
          .join("") || "<p>この範囲に該当するお会計はありません。</p>";
      if (data.some((t) => !t))
        body.insertAdjacentHTML(
          "beforeend",
          "<p>索引処理中の取引があります。</p>",
        );
    } catch {
      body.textContent =
        "履歴を読み込めませんでした。時間をおいて更新してください。";
    } finally {
      btn.disabled = false;
    }
  }
  details.ontoggle = () => {
    if (details.open && !body.textContent) refresh();
  };
  btn.onclick = refresh;
}
