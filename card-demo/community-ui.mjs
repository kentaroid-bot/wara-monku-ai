import { CATEGORIES } from "./community.mjs";

export const escape = value => String(value).replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function registerURL(c, shop) {
  return "/shop/?" + new URLSearchParams({ area: c.id, store: shop.id });
}

export function communityPage(state) {
  const selected = new URLSearchParams(location.search).get("id");
  const c = state.registry.find(entry => entry.id === selected);
  if (!c) return `<section class="panel"><h2>コミュニティ一覧</h2>${state.registry.map(entry =>
    `<div class="history-row"><a href="/communities/?id=${encodeURIComponent(entry.id)}">${escape(entry.name)}</a><small>${escape(entry.category)} · 公認店舗 ${entry.shops.length}</small></div>`
  ).join("")}</section>
  <section class="panel"><h2>新規開設</h2><form id="createCommunity" class="manage-form">
  <label>ID（英小文字・数字・ハイフン）<input name="communityId" maxlength="40" required pattern="[a-z0-9][a-z0-9\\-]*"></label>
  <label>名称<input name="name" maxlength="50" required></label>
  <label>カテゴリ<select name="category">${CATEGORIES.map(x => `<option>${x}</option>`).join("")}</select></label>
  <label>説明<input name="description" maxlength="240"></label><button>開設する</button></form></section>`;
  const peers = state.registry.filter(peer => peer.id !== c.id).map(peer => {
    let decision = "request", label = "提携を申請";
    if (c.allies.includes(peer.id)) { decision = "remove"; label = "提携を解除"; }
    else if (c.requests.includes(peer.id)) { decision = "accept"; label = "申請を承認"; }
    else if (peer.requests.includes(c.id)) { decision = ""; label = "申請中"; }
    return `<div class="history-row"><span>${escape(peer.name)}</span><button class="secondary" data-peer="${escape(peer.id)}" data-decision="${decision}" ${decision ? "" : "disabled"}>${label}</button></div>`;
  }).join("");
  return `<p><a href="/communities/">コミュニティ一覧</a></p>
  <section class="panel"><h2>${escape(c.name)}</h2><p>${escape(c.category)} · ${escape(c.id)}</p><p>${escape(c.description)}</p></section>
  <section class="panel"><h2>公認店舗</h2>${c.shops.map(shop =>
    `<div class="history-row"><span>${escape(shop.name)}</span><a href="${escape(registerURL(c, shop))}">レジを開く</a></div>`).join("")}
    <form class="manage-form" id="addShop"><label>店舗名<input name="name" maxlength="50" required></label><button>店舗を公認する</button></form></section>
  <section class="panel"><h2>通貨同盟</h2><p>相手の管理画面で申請を承認すると、双方の店舗で相手が発行したWARAを使えます。</p>${peers}</section>`;
}

export function bindCommunities(update) {
  const id = new URLSearchParams(location.search).get("id");
  const create = document.getElementById("createCommunity");
  if (create) create.onsubmit = e => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(create));
    if (update({ type: "createCommunity", ...fields }))
      location.assign("/communities/?id=" + encodeURIComponent(fields.communityId.trim()));
  };
  const add = document.getElementById("addShop");
  if (add) add.onsubmit = e => {
    e.preventDefault();
    update({type: "addShop", communityId: id, name: new FormData(add).get("name")});
  };
  document.querySelectorAll("[data-peer]").forEach(button => button.onclick = () =>
    update({type: "setAlliance", communityId: id, peerId: button.dataset.peer, decision: button.dataset.decision}));
}
