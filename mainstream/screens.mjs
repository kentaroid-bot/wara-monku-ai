import { shopRequestAPI } from "./shop-requests.mjs";
import { shopProfiles, shopTitle, shopDetails } from "./shop-profile.mjs";
import { twinCards } from "./balances.mjs";
import { showHistory } from "./history.mjs";
import { scannerBox } from "./scan.mjs";
import { pendingInvite } from "./community-privacy.mjs";
import { program, rpc, loadState, submit, checkPending, pendingSig } from "./network.mjs";
import { createRegisterWatch } from "./shop-register-watch.mjs";
import { communityViews } from "./views/community.mjs";
import { shopView } from "./views/shop.mjs";
import { viewHelpers, receipt } from "./views/ui.mjs";

export async function dashboard(ctx) {
  const { el, info, path, profile, wallet, action, recordPayment, readHistory, esc: h } = ctx,
    who = profile.address,
    params = new URLSearchParams(location.search);
  const content = document.createElement("div");
  el.append(content);
  const registerWatch = createRegisterWatch({ rpc });
  const ui = html => { registerWatch.stop(); content.innerHTML = html; };
  const helpers = viewHelpers(content, action, h);
  const profiles = shopProfiles(profile, wallet);
  const requests = shopRequestAPI(profile, wallet);
  let s = null;
  let sequence = 0, reading = false, retryTimer;
  const directory = path === "/communities";
  const refresh = async (force = false, retryName = true) => {
    const turn = ++sequence;
    reading = true;
    clearTimeout(retryTimer);
    info("Devnetを読み込み中…");
    try {
      const requestedShop = path === "/shop" && params.has("group") && params.has("store")
        ? {group:params.get("group"), store:params.get("store")} : null;
      const state = await loadState(who, force, requestedShop, directory);
      if (turn !== sequence) return false;
      s = state;
      if (directory) {
        view();
        info(s.communitySyncError);
        // Names and membership are already available. Enhance only visible shop labels,
        // without replacing forms or waiting for an unrelated shop/pending transaction.
        const labels = [...content.querySelectorAll("[data-shop-label]")];
        const ids = new Set(labels.map(el=>el.dataset.shopLabel));
        if (ids.size) void profiles.load(s, row=>ids.has(row.id)).then(()=>{
          if (turn !== sequence) return;
          const stores = new Map(state.rows.filter(r=>ids.has(r.id)).map(r=>[r.id,r]));
          for (const el of labels) {
            const st = stores.get(el.dataset.shopLabel);
            if (st) el.innerHTML = h(shopTitle(st)) + (el.dataset.registerLabel ? "のレジ" : "") + shopDetails(st,h);
          }
        }).catch(()=>{}); // On-chain store names remain usable.
        if (pendingSig(who)) void checkPending(who).catch(e=>{
          if (turn === sequence && document.querySelector("#notice").textContent === state.communitySyncError)
            info([state.communitySyncError,e.message].filter(Boolean).join(" "));
        });
        if (retryName && s.groups.some(g=>g.nameUnavailable)) retryTimer = setTimeout(()=>{
          if (!document.hidden && turn === sequence && !content.querySelector("form:focus-within")) void refresh(false,false);
        }, 30000);
        return true;
      }
      let profileError = "";
      try { await profiles.load(s); }
      catch { profileError = "店舗プロフィールを取得できません。「更新」で再試行できます。"; }
      let pendingNotice = "";
      if (pendingSig(who)) {
        try { await checkPending(who); }
        catch (error) { pendingNotice = error.message; }
      }
      if (turn !== sequence) return false;
      view();
      info([s.communitySyncError, profileError, pendingNotice].filter(Boolean).join(" "));
      return true;
    } catch (e) {
      if (turn !== sequence) return false;
      ui("<p>最新の状態を表示できません。「更新」で再確認してください。</p>");
      info("取得できません：" + e.message);
      return false;
    } finally { if (turn === sequence) reading = false; }
  };
  const send = async (ix, extra = [], msg = "取引が確定しました。", onConfirmed) => {
    const sig = await submit(profile, wallet, ix, extra);
    onConfirmed?.();
    const refreshed = await refresh(
      ix.some(
        (i) =>
          i.programId.equals(program) && ((i.data[0] >= 10 && i.data[0] <= 13) || i.data[0] === 17 || i.data[0] === 18),
      ),
    );
    info(msg + (refreshed ? (s.communitySyncError ? " " + s.communitySyncError : "") : " 残高は「更新」で再確認してください。"));
    const a = document.createElement("a");
    a.href = receipt(sig);
    a.textContent = " Devnetの取引を見る";
    a.target = "_blank";
    a.rel = "noopener";
    document.querySelector("#notice").append(a);
    return sig;
  };
  const by = (id) => s.groups.find((g) => g.id === id);
  const shopName = (group, address) =>
    s.rows.find(r => r.tag === 32 && r.group === group && r.to === address)?.name;
  const outgoing = (a, b) =>
    s.rows.some(
      (r) => r.tag === 34 && r.group === a && r.to === b && r.status === 1,
    );
  const viewContext = { ...ctx, ...helpers, state: () => s, content, params, who, profiles,
    requests, ui, by, shopName, outgoing, send, view, refresh, h, registerWatch };
  const { newGroup, community } = communityViews(viewContext);
  const store = shopView(viewContext);
  function view() {
    if (path === "/communities/new") return newGroup();
    if (path === "/communities") return community();
    if (path === "/shop") return store();
    ui(twinCards(s) +
      '<div class="quick-actions"><a class="action" href="/shop/">支払う</a><a class="action secondary" href="/shop/?mode=receive">レジを開く</a></div>');
    showHistory(content, readHistory, null, h, by, shopName);
    scannerBox(content, "store", (url) => location.assign(url));
    content.insertAdjacentHTML("beforeend", `<details><summary>WARAの発行元</summary>
      ${[...s.funds].map(([id, n]) => `<p>${h(by(id)?.name || id)}：${n} WARA</p>`).join("") || "<p>まだWARAはありません。</p>"}</details>`);
  }
  if (path === "/communities/new") {
    newGroup();
    return;
  }
  ui("<p>Devnetの最新状態を確認しています…</p>");
  const reload = document.createElement("button");
  reload.textContent = "更新";
  reload.className = "secondary";
  reload.onclick = () => refresh(true);
  el.append(reload);
  if (directory) {
    const revisit = () => {
      if (!reading && !document.hidden && !content.querySelector("form:focus-within") &&
          !s?.groups.some(g=>g.owner === who && g.id === params.get("id"))) void refresh();
    };
    document.addEventListener("visibilitychange",revisit);
    window.addEventListener("pageshow",e=>{ if(e.persisted) revisit(); });
  }
  const invited = params.get("id");
  await refresh(path === "/communities" && Boolean(invited && sessionStorage.getItem(pendingInvite(invited))));
}
