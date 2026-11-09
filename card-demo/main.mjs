import { initialRegistry, userFunds, availableFunds, merchant, community } from "./community.mjs";
import { communityPage, bindCommunities, escape, registerURL } from "./community-ui.mjs";
import { createScanner } from "../app/qr-media.mjs";
import QRCode from "qrcode";
import { fresh, transition, PIN, DAILY_KUSA, distribution, WALLET_TYPES, cardPayload } from "./model.mjs";
const KEY = "straw-card-ui-demo-v3",
  $ = (id) => document.getElementById(id);
const route = location.pathname.split("/").filter(Boolean)[0];
const role = ["user", "shop", "support", "account", "communities"].includes(route) ? route : "user";
let cardOpen = false,
  storageWarning = false;
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const s = JSON.parse(raw);
    if (
      s.version !== 3 ||
      !Number.isSafeInteger(s.spent) ||
      s.spent < 0 ||
      s.spent > DAILY_KUSA ||
      !Number.isSafeInteger(s.day) ||
      s.day < 1 ||
      !Number.isSafeInteger(s.cardVersion) ||
      s.cardVersion < 1 ||
      !Array.isArray(s.history) ||
      typeof s.cardActive !== "boolean" ||
      !Number.isInteger(s.attempts) ||
      s.attempts < 0
    )
      throw Error("invalid");
    s.registry ??= initialRegistry();
    s.transfers ??= [];
    const known = id => s.registry.some(c => c.id === id);
    const validId = id => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
    if (!s.registry.length || !s.registry.every(c =>
      validId(c.id) && typeof c.name === "string" && Array.isArray(c.shops) &&
      c.shops.every(shop => typeof shop.id === "string" && typeof shop.name === "string") &&
      c.allies.every(known) && c.requests.every(known)))
      throw Error("invalid communities");
    const knownShop = r => s.registry.some(c => c.id === r.communityId &&
      c.shops.some(shop => shop.id === (r.shopId ?? "S-001")));
    if (!s.transfers.every(t => t && typeof t.id === "string" && typeof t.time === "string" &&
      knownShop(t) && Number.isSafeInteger(t.day) && Number.isSafeInteger(t.amount) && t.amount > 0 &&
      Array.isArray(t.origins) && t.origins.every(l => known(l.id) && Number.isSafeInteger(l.amount) && l.amount > 0) &&
      t.origins.reduce((sum, l) => sum + l.amount, 0) === t.amount))
      throw Error("invalid transfers");
    const validPayment = (p) =>
      p &&
      typeof p.id === "string" &&
      Number.isSafeInteger(p.amount) &&
      p.amount >= 1 &&
      p.amount <= DAILY_KUSA &&
      knownShop(p) &&
      Number.isSafeInteger(p.day) &&
      p.day >= 1 &&
      Number.isSafeInteger(p.cardVersion) &&
      p.cardVersion >= 1;
    if (
      s.pending &&
      (!validPayment(s.pending) ||
        !["confirm", "support"].includes(s.pending.status))
    )
      throw Error("invalid pending");
    if (
      !s.history.every(
        (p) =>
          validPayment(p) &&
          Number.isSafeInteger(p.remaining) &&
          p.remaining >= 0 &&
          p.remaining <= DAILY_KUSA &&
          p.shopCredit === distribution(p.amount).shopCredit &&
          p.userRefund === distribution(p.amount).userRefund &&
          typeof p.time === "string" &&
          ["pin", "support"].includes(p.method),
      )
    )
      throw Error("invalid history");
    // Earlier v3 receipts already identify the communities this card used.
    s.walletType ??= "embedded";
    s.communities ??= [...new Set(["midori-shoptown", ...s.history.map(h => h.communityId),
      ...(s.pending ? [s.pending.communityId] : [])])];
    if (!WALLET_TYPES.includes(s.walletType) || !Array.isArray(s.communities) ||
        !s.communities.length || !s.communities.every(id => known(id)))
      throw Error("invalid account");
    return s;
  } catch {
    storageWarning = true;
    return fresh();
  }
}
let state = read();
function message(text) {
  $("feedback").hidden = !text;
  $("feedback").textContent = text;
}
function write(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
  state = s;
}
function update(action) {
  try {
    write(transition(read(), action));
    render();
    return true;
  } catch (e) {
    message(
      e.message || "保存できません。ブラウザの保存設定を確認してください。",
    );
    return false;
  }
}
function time(x) {
  const d = new Date(x);
  return Number.isNaN(d.valueOf())
    ? "デモ時刻"
    : d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
const userTotal = () => [...userFunds(state).values()].reduce((a,b) => a+b, 0);
const areaName = id => escape(community(state, id).name);
const storeName = r => escape(merchant(state, r.communityId, r.shopId).name);
const received = r => r.origins ? r.amount : r.shopCredit;
function records() {
  return [...state.history, ...state.transfers].sort((a,b) => b.day - a.day || b.time.localeCompare(a.time));
}
function historyRows(rows, shop = false) {
  if (!rows.length) return '<p class="empty">まだお会計はありません。</p>';
  return rows.map(r => {
    const unit = shop || r.origins ? "WARA" : "Kusa";
    const note = r.origins ? "WARA払い" : (shop ? "Kusa払い" : r.userRefund + " WARA還付") +
      (r.method === "support" ? " · 窓口立ち会い" : " · 暗証番号");
    return `<div class="history-row"><div>${shop ? "あおいさん（デモ）" : storeName(r)}
    <small>${areaName(r.communityId)} · ${r.day}日目 · ${escape(time(r.time))} · ${note}</small></div>
    <strong>${shop ? received(r) : r.amount} ${unit}</strong></div>`;
  }).join("");
}
const link = (href, label, secondary = false) =>
  `<a class="button${secondary ? " secondary" : ""}" href="${escape(href)}">${escape(label)}</a>`;
function printedCard() {
  return `<div class="qr-card"><span class="pill">画面モック専用 · 実際には使えません</span><p><strong>あおいさんの Kusaカード</strong></p><img id="cardQr" alt="デモ参加者C-001を示すQRコード"><p>C-001 · カード ${state.cardVersion}</p><p class="small">公開IDのみ。QRは本人の同意や署名ではありません。</p><button disabled id="printCard" class="secondary">このカードを印刷</button></div>`;
}

function account() {
  const funds = userFunds(state);
  const rows = state.registry.map(({id, name}) => {
    const amount = funds.get(id);
    return `<div class="history-row"><span>${escape(name)}</span><strong>${amount} WARA</strong></div>`;
  }).join("");
  return `<section class="panel"><h2>プロフィール</h2><p>あおいさん · C-001</p>
<p>電話番号 090-****-1234 · 認証済み（デモ）</p>
<label for="walletType" class="label">ウォレット種別（デモ）</label><select id="walletType">
<option value="embedded" ${state.walletType === "embedded" ? "selected" : ""}>組み込みウォレット（自動生成）</option>
<option value="phantom" ${state.walletType === "phantom" ? "selected" : ""}>外部ウォレット（Phantom）</option></select></section>
<section class="panel"><h2>保有WARAの内訳</h2>${rows}<p>合計 <strong>${userTotal()} WARA</strong></p></section>
<section class="panel"><h2>参加コミュニティ</h2><ul>${state.communities.map(id => `<li>${areaName(id)}</li>`).join("")}</ul>
<form id="joinForm"><label class="label" for="invite">招待コード</label><input id="invite" required maxlength="32" placeholder="WASEDA2026"><button>参加する</button></form></section>
<section class="panel"><h2>紙カード</h2>${state.cardActive ? printedCard() + '<button id="stopCard" class="danger">紛失したカードを停止する</button>' : '停止中です。' + link("/support", "地域窓口で再発行", true)}</section>`;
}
function user() {
  const remaining = DAILY_KUSA - state.spent;
  const leaves = Array.from({ length: DAILY_KUSA }, (_, i) =>
    `<span class="leaf${i < remaining ? "" : " spent"}"></span>`
  ).join("");
  return `<div class="grid">
<section class="panel balance"><p class="muted">今日あと使えるKusa</p><div class="big">${DAILY_KUSA - state.spent} <small class="gold">Kusa</small></div><p class="muted">あおいさん · Kusaアカウント C-001（デモ）</p><div class="leaves" aria-hidden="true">${leaves}</div><p class="small" style="color:#d5e0cf">今日使った ${state.spent} / ${DAILY_KUSA} Kusa</p>
</section>
<section class="panel"><h2>持っているWARA</h2><div class="number">${userTotal()} <small>WARA</small></div><p class="muted">支払い時に還付されたWARAは翌日も残ります。</p><p class="info-strip">WARA用ウォレットの接続は、このモックでは行いません。</p>
</section></div>
<section class="panel"><h2>あなたのQRカード</h2><p class="muted">${state.cardActive ? "紙のカードをお店に出すだけ。端末を持たない人も、地域窓口でカードを受け取る想定です。" : "カードは停止中です。地域窓口で再発行できます。"}</p>
<div class="actions" style="margin-top:18px"><button id="showCard" ${state.cardActive ? "" : "disabled"}>${cardOpen ? "カードを閉じる" : "QRカードを表示"}</button>${link("/shop", "お店で支払いを試す", true)}</div>${cardOpen && state.cardActive ? printedCard() : ""}</section>
<section class="panel" id="history"><h2>買い物の履歴</h2>${historyRows(records())}</section>
<section class="panel"><h2>カード・暗証番号の相談</h2><p class="muted">なくしたとき、暗証番号を使えないときは地域の窓口へ。端末がない場合は、窓口で残り枠や履歴も確認できる想定です。</p><p>${link("/support", "地域の窓口を見る", true)}</p>
</section>`;
}
function success(receipt, todayTotal) {
  return `
<section class="panel confirm"><div class="receipt-mark" aria-hidden="true">✓</div><h2>支払いが完了しました</h2><p class="small">デモのお会計 · ${escape(receipt.id)}</p><div class="big">${escape(receipt.amount)} <small>Kusa</small></div><p>店に <b>${receipt.shopCredit} WARA</b>、客に <b>${receipt.userRefund} WARA</b> 還付</p><p>発行元：${areaName(receipt.communityId)}</p><div class="receipt-meta"><div>お客さんの支払い直後の残り<strong>${escape(receipt.remaining)} Kusa</strong></div><div>店の今日の受取<strong>${todayTotal} WARA</strong></div></div>
<div class="actions"><button id="nextCheckout">次のお会計</button>${link("/user", "利用者の残りを確認", true)}<button id="printReceipt" class="secondary">紙の控えを出す</button></div><p class="small">実際の送金はありません。${receipt.method === "support" ? "地域の確認役が立ち会う流れを体験しました。" : "デモ暗証番号で確認しました。"}</p>
</section>`;
}
function shop() {
  const params = new URLSearchParams(location.search), id = params.get("checkout");
  const receipt = records().find(h => h.id === id);
  const pending = state.pending;
  const p = pending && (!id || pending.id === id) &&
    (!params.has("area") || params.get("area") === pending.communityId) &&
    (!params.has("store") || params.get("store") === (pending.shopId || "S-001")) ? pending : null;
  const invoice = receipt || p;
  const areaId = invoice?.communityId || params.get("area") || state.registry[0].id;
  const area = state.registry.find(c => c.id === areaId);
  const storeId = invoice?.shopId || params.get("store") || "S-001";
  const store = area?.shops.find(x => x.id === storeId);
  if (!store) return '<section class="panel">公認店舗を選んでください。 <a href="/communities/">コミュニティ一覧へ</a></section>';
  const rows = records().filter(r => r.communityId === area.id && (r.shopId || "S-001") === store.id);
  const todayRows = rows.filter(r => r.day === state.day);
  const sum = items => items.reduce((n,r) => n + received(r), 0);
  const lots = availableFunds(state, area.id);
  const accepted = lots.reduce((n, lot) => n + lot.amount, 0);
  const units = state.communities.includes(area.id) ? DAILY_KUSA - state.spent : 0;
  let panel;
  if (receipt?.origins) panel = `<section class="panel confirm"><h2>WARAで支払いました</h2>
    <p>${storeName(receipt)}に <b>${receipt.amount} WARA</b> 届きました。</p>
    <details><summary>発行元の内訳</summary>${receipt.origins.map(l => `<p>${areaName(l.id)} · ${l.amount} WARA</p>`).join("")}</details>
    <button id="nextCheckout">次のお会計</button></section>`;
  else if (receipt) panel = success(receipt, sum(todayRows));
  else if (p?.status === "support")
    panel = `
<section class="panel confirm"><p class="eyebrow">確認役の立ち会い</p><h2>地域の窓口で確認を待っています</h2><div class="big">${p.amount} <small>Kusa</small></div><p>あおいさん → ${storeName(p)} · ${areaName(p.communityId)}</p><p class="muted">まだ枠は減っていません。店員だけで代理承認する流れにはしません。</p><p>${link("/support", "確認役の画面へ")}</p><button id="cancel" class="secondary">このお会計を取り消す</button>
</section>`;
  else if (p)
    panel = `
<section class="panel confirm"><p class="flow-steps">カード読取 → <b>本人が金額を確認</b> → 完了</p><h2>${storeName(p)}へ支払います</h2><p>${areaName(p.communityId)}</p><div class="big">${p.amount} <small>Kusa</small></div><p>あおいさん · 支払い後の残り <b>${DAILY_KUSA - state.spent - p.amount} Kusa</b></p>
<form id="payForm"><label class="label" for="pin">本人がデモ暗証番号を入力</label><input id="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" required aria-describedby="pinHelp" ${state.attempts >= 3 ? "disabled" : ""}><p class="small" id="pinHelp">体験用は <b>${PIN}</b>。本物の暗証番号は入力しないでください。<br>${state.attempts ? `入力間違い ${state.attempts}/3回。` : ""}</p><button type="submit" ${state.attempts >= 3 ? "disabled" : ""}>${p.amount} Kusaで支払う</button>
</form><p><button id="askSupport" class="secondary">暗証番号を使えない方</button></p><button id="cancel" class="secondary">取り消す</button>
</section>`;
  else
    panel = `
<section class="panel"><p class="flow-steps"><b>金額入力・カード読取</b> → 本人が確認 → 完了</p><h2>新しいお会計</h2>
<label class="label" for="community">店舗のコミュニティ</label><select id="community">${state.registry.filter(c => c.shops.length).map(c => `<option value="${escape(c.id)}" ${c.id === area.id ? "selected" : ""}>${escape(c.name)}</option>`).join("")}</select>
<label for="store">公認店舗</label> <select id="store">${area.shops.map(x => `<option value="${escape(x.id)}" ${x.id === store.id ? "selected" : ""}>${escape(x.name)}</option>`).join("")}</select>
<form id="checkoutForm">
<label for="checkoutAmount" class="label">支払い額（残り ${units} Kusa）</label><div class="actions presets"><button type="button" id="coffee" class="secondary" ${units === 0 ? "disabled" : ""}>コーヒー · 1 Kusa</button><button type="button" id="meal" class="secondary" ${units < 5 ? "disabled" : ""}>定食 · 5 Kusa</button></div><div class="input-row"><input id="checkoutAmount" type="number" min="1" max="${units}" step="1" value="${units > 0 ? 1 : ""}" required ${units === 0 ? "disabled" : ""}><small>Kusa</small></div><button id="scanCard" type="button" ${state.cardActive && units > 0 ? "" : "disabled"}>カメラでカードを読む</button> <button class="secondary" type="submit" ${state.cardActive && units > 0 ? "" : "disabled"}>デモカードを読み取る</button>
</form><p class="small">カメラがない場合はデモカードを選んでください。</p>${!state.cardActive ? '<p class="disabled-note">カードは停止中です。地域窓口で再発行してください。</p>' : ""}<p class="info-strip">店員が金額を入れたら、次の画面をお客さんに向けます。</p>
</section>
<section class="panel"><h2>持っているWARAで支払う</h2><p>この店で使えるWARA <strong>${accepted} WARA</strong></p>
<details><summary>内訳</summary>${lots.map(l => `<p>${areaName(l.id)} · ${l.amount} WARA</p>`).join("") || "0 WARA"}</details>
<form id="waraForm" class="manage-form"><label>支払い額（WARA）<input name="amount" type="number" min="1" step="1" required></label><button>WARAで支払う</button></form>
</section>`;
  return (
    panel +
    `<div class="grid">
<section class="panel"><h2>今日の受取</h2><div class="number">${sum(todayRows)} <small>WARA</small></div><p class="muted">体験 ${state.day}日目 · ${todayRows.length}件</p>
</section>
<section class="panel"><h2>店のWARA残高</h2><div class="number">${sum(rows)} <small>WARA</small></div><p class="muted">翌日に進んでも残ります。</p>
</section></div>
<section class="panel"><h2>お会計ごとの受取履歴</h2>${historyRows(rows, true)}</section>`
  );
}
function support() {
  const p = state.pending;
  return `
<section class="panel"><p class="eyebrow">立ち会い承認</p><h2>${p?.status === "support" ? "確認を待っているお会計" : "今は立ち会いの依頼がありません"}</h2>${
    p?.status === "support"
      ? `<p>あおいさん → <b>${storeName(p)}</b> · ${areaName(p.communityId)}</p><div class="number">${p.amount} <small>Kusa</small></div><p>支払い後の残り：<b>${DAILY_KUSA - state.spent - p.amount} Kusa</b></p>
<form id="supportForm"><label class="check"><input id="consent" type="checkbox" required><span>本人と店名・金額を確認し、本人がこの支払いを希望していることを確かめました（デモ）。</span></label><button type="submit">確認役として承認する（デモ）</button>
</form><p class="small">確認役：地域窓口の青葉さん（架空）。この画面は誰でも切り替えられるモックで、実際の権限チェックはありません。</p>`
      : `<p class="muted">店の金額確認画面で「暗証番号を使えない方」を選ぶと、ここに届きます。</p>${link("/shop", "店の画面へ", true)}`
  }</section><div class="support-list">
<section class="panel"><h2>カードの相談</h2><p>あおいさん · C-001</p><p><span class="pill">${state.cardActive ? "カード有効" : "カード停止中"} · 第${state.cardVersion}版</span></p><p class="muted">今日の残り：${DAILY_KUSA - state.spent} Kusa</p>
<div class="actions" style="margin-top:18px"><button id="stopCard" class="danger" ${state.cardActive ? "" : "disabled"}>カードを停止</button><button id="reissueCard" class="secondary">再発行を試す</button></div><p class="small">再発行しても今日の使用額は引き継ぎます。進行中のお会計は取り消されます。デモの暗証番号は123456です。</p>
</section>
<section class="panel"><h2>初めての参加・利用相談</h2><p class="muted">地域で実在と重複登録を確認し、Kusaアカウントとカードを用意する想定です。</p><p class="info-strip">この体験ではC-001を登録済みとして用意しています。実際の受付・本人確認・暗証番号再設定は未実装です。</p>${link("/user", "残り枠と履歴を見る", true)}</section></div>`;
}
function bind(id, event, fn) {
  const el = $(id);
  if (el) el.addEventListener(event, fn);
}
function checkoutURL(id) {
  const url = new URL(location.href);
  const purchase = records().find(r => r.id === (id || url.searchParams.get("checkout"))) || state.pending;
  if (purchase) {
    url.searchParams.set("area", purchase.communityId);
    url.searchParams.set("store", purchase.shopId || "S-001");
  }
  if (id) url.searchParams.set("checkout", id);
  else url.searchParams.delete("checkout");

  history.replaceState(
    null,
    "",
    url,
  );
}
function startCheckout(card) {
  const form = $("checkoutForm");
  if (!form || !form.reportValidity()) return;
  const id = crypto.randomUUID();
  if (update({ type: "checkout", id, card, communityId: $("community").value, shopId: $("store").value,
               amount: Number($("checkoutAmount").value) })) {
    checkoutURL(id);
    message("カードを読み取りました。本人が金額を確認してください。");
  }
}

const scanner = createScanner({
  video: $("scanVideo"), canvas: $("scanCanvas"),
  onValue(value) { closeScanner(); startCheckout(value); },
  onStatus(status) { $("scanStatus").textContent = status; },
  onStop() {},
});
function closeScanner() {
  scanner.stop();
  if ($("scanDialog").open) $("scanDialog").close();
}
$("closeScan").onclick = closeScanner;
$("scanDialog").addEventListener("cancel", closeScanner);
window.addEventListener("pagehide", closeScanner);
document.addEventListener("visibilitychange", () => { if (document.hidden) closeScanner(); });
window.addEventListener("afterprint", () => document.body.classList.remove("printing-card"));

function render() {
  if ($("scanDialog").open) closeScanner();
  const meta = {
    user: ["今日のあなたの財布", "今日使える枠と買い物の履歴を確認できます。"],
    shop: ["お店のレジ", "支払い方法を選んでください。"],
    communities: ["コミュニティ", "店舗の公認と通貨同盟を管理します（デモ）。"],
    account: ["アカウント", "登録情報と紙カードを管理します。"],
    support: [
      "地域の確認窓口",
      "支払いへの立ち会いと、カードの停止・再発行ができます。",
    ],
  }[role];
  $("title").textContent = meta[0];
  $("subtitle").textContent = meta[1];
  $("demoDay").textContent = `体験 ${state.day}日目`;
  document.querySelectorAll("[data-route]").forEach((a) => {
    if (a.dataset.route === role) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("content").innerHTML =
    role === "user" ? user() : role === "shop" ? shop() : role === "account" ? account() : role === "communities" ? communityPage(state) : support();
  if (role === "communities") bindCommunities(update);
  bind("showCard", "click", () => {
    cardOpen = !cardOpen;
    render();
  });
  if ($("cardQr")) {
    const img = $("cardQr");
    QRCode.toDataURL(
      cardPayload(state),
      { width: 220, margin: 2 },
    )
      .then((url) => {
        if (img.isConnected) {
          img.onload = () => { if (img.isConnected) $("printCard").disabled = false; };
          img.src = url;
        }
      })
      .catch(() => message("QR画像を作れませんでした。"));
  }
  bind("printReceipt", "click", () => window.print());
  bind("printCard", "click", () => {
    document.body.classList.add("printing-card");
    window.print();
  });
  bind("walletType", "change", () => update({ type: "setWallet", walletType: $("walletType").value }));
  bind("joinForm", "submit", event => {
    event.preventDefault();
    if (update({ type: "joinCommunity", code: $("invite").value })) message("コミュニティに参加しました。");
  });
  for (const [id, amount] of [["coffee", 1], ["meal", 5]])
    bind(id, "click", () => { $("checkoutAmount").value = amount; });
  bind("community", "change", () => {
    const c = community(state, $("community").value);
    location.assign(registerURL(c, c.shops[0]));
  });
  bind("store", "change", () => {
    const c = community(state, $("community").value);
    location.assign(registerURL(c, merchant(state, c.id, $("store").value)));
  });
  bind("waraForm", "submit", e => {
    e.preventDefault();
    const amount = Number(new FormData(e.target).get("amount"));
    const communityId = $("community").value, shopId = $("store").value;
    if (!window.confirm(merchant(state, communityId, shopId).name + "へ " + amount + " WARAを支払いますか？")) return;
    const id = crypto.randomUUID();
    if (update({type: "payWara", id, shopId, communityId, amount, time: new Date().toISOString()})) {
      checkoutURL(id);
      render();
      message("WARAの支払いが完了しました。");
    }
  });
  bind("scanCard", "click", async () => {
    if (!$("checkoutForm").reportValidity()) return;
    $("scanDialog").showModal();
    try { await scanner.start("card"); }
    catch { $("scanStatus").textContent = "カメラを開始できません。閉じてデモカードを使用できます。"; }
  });
  bind("checkoutForm", "submit", (e) => {
    e.preventDefault();
    startCheckout();
  });
  bind("payForm", "submit", (e) => {
    e.preventDefault();
    const id = state.pending?.id,
      pin = $("pin").value;
    if (update({ type: "pay", id, pin, time: new Date().toISOString() })) {
      if (state.pending)
        message(
          state.attempts >= 3
            ? "入力を3回間違えました。立ち会いの経路を利用できます。"
            : "デモ暗証番号が違います。123456で試してください。",
        );
      else {
        checkoutURL(id);
        render();
        message("模擬決済が完了しました。");
      }
    }
  });
  bind("askSupport", "click", () => {
    if (update({ type: "requestSupport" }))
      message("地域の確認役へ立ち会いを依頼しました（デモ）。");
  });
  bind("cancel", "click", () => {
    if (update({ type: "cancel" })) {
      checkoutURL(null);
      render();
      message("取り消しました。Kusaは使っていません。");
    }
  });
  bind("nextCheckout", "click", () => {
    checkoutURL(null);
    render();
    message("次のお会計を準備できます。");
    $("checkoutAmount")?.focus();
  });
  bind("supportForm", "submit", (e) => {
    e.preventDefault();
    const id = state.pending?.id;
    if (
      update({
        type: "approve",
        id,
        consent: $("consent").checked,
        time: new Date().toISOString(),
      })
    ) {
      message("本人の希望を確認し、承認しました（デモ）。");
      const a = document.createElement("a");
      a.href = `/shop?checkout=${encodeURIComponent(id)}`;
      a.textContent = " 店の完了画面を見る →";
      $("feedback").append(a);
    }
  });
  bind("stopCard", "click", () => {
    if (update({ type: "stop" })) message("カードを停止しました。");
  });
  bind("reissueCard", "click", () => {
    if (update({ type: "reissue" }))
      message("カードを再発行しました。今日の使用額は増減しません。");
  });
}
$("nextDay").onclick = () => {
  if (update({ type: "nextDay" })) {
    if (role === "shop") checkoutURL(null);
    render();
    message(
      "体験の日付を進めました。Kusaは10に更新され、店と客のWARAは残ります。",
    );
  }
};
$("resetDemo").onclick = () => {
  if (
    !window.confirm(
      "このブラウザの体験データを消して、10 Kusaからやり直しますか？",
    )
  )
    return;
  try {
    write(fresh());
    cardOpen = false;
    if (role === "shop") checkoutURL(null);
    render();
    message("体験を初期状態へ戻しました。");
  } catch {
    message("体験データを保存できません。");
  }
};
window.addEventListener("storage", (e) => {
  if (e.key === KEY) {
    state = read();
    render();
    message("別の画面で行った操作を反映しました。");
  }
});
render();
if (storageWarning)
  message("保存データを読み取れなかったため、初期状態を表示しています。");
