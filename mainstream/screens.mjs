import { shopRequestAPI } from "./shop-requests.mjs";
import { shopProfiles, enhanceShopProfiles } from "./shop-profile.mjs";
import { twinCards, crystallize } from "./balances.mjs";
import { entries, showHistory } from "./history.mjs";
import { scannerBox } from "./scan.mjs";
import { pendingInvite } from "./community-privacy.mjs";
import { program, rpc, loadState, submit, checkPending, pendingSig, settlementEvents } from "./network.mjs";
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
  let recoveryNotice = "";
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
      view();
      const initialNotice = [s.communitySyncError,recoveryNotice].filter(Boolean).join(" ");
      info(initialNotice);
      void enhanceShopProfiles(profiles, state, content, h,
        () => turn === sequence && content.isConnected, directory).then(profileError => {
        if (turn !== sequence || !content.isConnected || !profileError) return;
        // A delayed profile error must not erase a payment result or its receipt.
        if (document.querySelector("#notice")?.textContent === initialNotice)
          info([state.communitySyncError,profileError,recoveryNotice].filter(Boolean).join(" "));
      });
      if (directory && retryName && s.groups.some(g=>g.nameUnavailable)) retryTimer = setTimeout(()=>{
        if (!document.hidden && turn === sequence && !content.querySelector("form:focus-within")) void refresh(false,false);
      }, 30000);
      return true;
    } catch (e) {
      if (turn !== sequence) return false;
      ui("<p>最新の状態を表示できません。「更新」で再確認してください。</p>");
      info("取得できません：" + e.message);
      return false;
    } finally { if (turn === sequence) reading = false; }
  };
  // Older pending records only contain the signature/receipt. Recover their
  // currency and amount from the confirmed transaction itself.
  async function showSettlement({address,sig,payment}) {
    if (address !== who || !content.isConnected) return;
    if (payment === undefined) {
      const tx = await rpc.getTransaction(sig,{commitment:"confirmed",maxSupportedTransactionVersion:0});
      const rows = entries(tx,sig,who);
      if (!rows.length) return;
      payment = {amount:rows.reduce((sum,row)=>sum+row.n,0n),currency:rows[0].kusa ? "ina" : "wara",incoming:rows[0].incoming};
    }
    if (payment) {
      recordPayment();
      crystallize(BigInt(payment.amount),payment.incoming,payment.currency);
    }
  }
  settlementEvents.addEventListener("confirmed", e=>{
    void showSettlement(e.detail).catch(()=>{}); // Confirmation stands even when legacy receipt details are unavailable.
  });

  let checking = false, pendingTimer;
  function scheduleCheck() {
    clearTimeout(pendingTimer);
    if (!document.hidden && pendingSig(who)) pendingTimer = setTimeout(recover,4000);
  }
  async function recover() {
    if (checking || document.hidden || !pendingSig(who)) return;
    checking = true;
    try {
      const sig = await checkPending(who);
      if (sig) {
        recoveryNotice = "取引の確定を確認しました。";
        await refresh();
      }
    } catch (error) {
      recoveryNotice = pendingSig(who) ? "送信した取引を確認中です。支払いは再送せずにお待ちください。" : error.message;
      info(recoveryNotice);
    } finally {
      checking = false;
      scheduleCheck();
    }
  }
  settlementEvents.addEventListener("waiting", e=>{ if (e.detail.address === who) scheduleCheck(); });
  document.addEventListener("visibilitychange",()=>{ if (!document.hidden) void recover(); });
  window.addEventListener("pageshow",e=>{ if (e.persisted) void recover(); });
  const send = async (ix, extra = [], msg = "取引が確定しました。") => {
    const sig = await submit(profile, wallet, ix, extra);
    recoveryNotice = "";
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
  reload.onclick = () => { void recover(); void refresh(true); };
  void recover();
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
