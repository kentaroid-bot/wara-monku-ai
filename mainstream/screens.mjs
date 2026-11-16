import { dialogPanel } from "./ehon-dialog.mjs";
import { registerChoices } from "./shop-directory.mjs";
import { shopTitle } from "./shop-profile.mjs";
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
  const { el, info, path, profile, wallet, senderWallet = wallet, action, recordPayment, readHistory, esc: h } = ctx,
    who = profile.address,
    senderWho = profile.senderAddress || who,
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
  let sent;
  if (path === "/" || path === "/user") {
    try { sent = JSON.parse(sessionStorage.getItem("wara.ui.sent") || "null"); sessionStorage.removeItem("wara.ui.sent"); } catch {}
    if (sent) recoveryNotice = "贈りました。相手に " + sent.amount + " WARAが届きました。";
  }
  const directory = path === "/communities";
  const stage = ["/", "/user", "/shop"].includes(path);
  const refresh = async (force = false, retryName = true) => {
    const turn = ++sequence;
    reading = true;
    clearTimeout(retryTimer);
    info("Devnetを読み込み中…");
    try {
      const requestedShop = path === "/shop" && params.has("group") && params.has("store")
        ? {group:params.get("group"), store:params.get("store")} : null;
      const state = await loadState(who, force, requestedShop, directory, profile);
      if (turn !== sequence) return false;
      s = state;
      view();
      reload.hidden = stage;
      const initialNotice = [s.communitySyncError,recoveryNotice].filter(Boolean).join(" ");
      info(initialNotice);
      if (sent) {
        const a=document.createElement("a"); a.href=receipt(sent.sig); a.textContent=" Devnetの取引を見る"; a.target="_blank"; a.rel="noopener";
        document.querySelector("#notice").append(a);
        crystallize(BigInt(sent.amount),false,"wara"); sent=null;
      }
      void enhanceShopProfiles(profiles, state, content, h,
        () => turn === sequence && content.isConnected, directory).then(profileError => {
        if (turn !== sequence || !content.isConnected) return;
        if (!profileError) {
          content.querySelector("[data-payment-history]")?.dispatchEvent(new Event("refresh-history"));
          return;
        }
        // A delayed profile error must not erase a payment result or its receipt.
        if (document.querySelector("#notice")?.textContent === initialNotice)
          info([state.communitySyncError, (path === "/" || path === "/user") ? "" : profileError, recoveryNotice].filter(Boolean).join(" "));
      });
      if (directory && retryName && s.groups.some(g=>g.nameUnavailable)) retryTimer = setTimeout(()=>{
        if (!document.hidden && turn === sequence && !content.querySelector("form:focus-within")) void refresh(false,false);
      }, 30000);
      return true;
    } catch (e) {
      if (turn !== sequence) return false;
      ui("<p>最新の状態を表示できません。「更新」で再確認してください。</p>");
      reload.hidden = false;
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
      const rows = entries(tx,sig,who,null,senderWho);
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
      recoveryNotice = pendingSig(who) ? "送信した取引を確認中です。贈る操作は繰り返さずにお待ちください。" : error.message;
      info(recoveryNotice);
    } finally {
      checking = false;
      scheduleCheck();
    }
  }
  settlementEvents.addEventListener("waiting", e=>{ if (e.detail.address === who) scheduleCheck(); });
  document.addEventListener("visibilitychange",()=>{ if (!document.hidden) void recover(); });
  window.addEventListener("pageshow",e=>{ if (e.persisted) void recover(); });
  const send = async (ix, extra = [], msg = "取引が確定しました。", note = "", redraw = true) => {
    const access = note ? await profiles.noteAccess() : undefined;
    const sending = ix.at(-1)?.data[0] === 14;
    const sig = await submit(sending ? {...profile,address:senderWho} : profile, sending ? senderWallet : wallet, ix, extra, who, note, access);
    recoveryNotice = "";
    const refreshed = !redraw || await refresh(
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
  const viewContext = { ...ctx, ...helpers, state: () => s, content, params, who, senderWho, profiles,
    requests, ui, by, shopName, outgoing, send, view, refresh, h, registerWatch };
  const { newGroup, community } = communityViews(viewContext);
  const store = shopView(viewContext);
  function view() {
    if (path === "/communities/new") return newGroup();
    if (path === "/communities") return community();
    if (path === "/shop") return store();
    if (path === "/account") {
      ui("");
      // Complete the bounded receipt batches without blocking account controls.
      const accountHistory = async () => {
        let result;
        for (let batch = 0; batch < 4; batch++) {
          result = await readHistory();
          if (!result.indexing) break;
        }
        return result;
      };
      showHistory(content, accountHistory, null, h, by, shopName, profiles);
    } else {
      ui(twinCards(s));
      showHistory(content.querySelector(".home-history"), readHistory, null, h, by, shopName, profiles, true);
      const choices = document.createElement("div");
      choices.innerHTML = registerChoices(s.rows.filter(r=>r.tag===32),s,who,false,senderWho).map(st=>`<a class="shop-row recipient-row" href="${h(helpers.register(st.group,st.to))}"><span data-shop-label="${h(st.id)}" data-compact-label="1">${h(shopTitle(st))}</span><strong>贈る ›</strong></a>`).join("") || "<p>参加中のコミュニティに受け取り相手はまだいません。</p>";
      const picker = dialogPanel(content,"相手を選ぶ",[choices]);
      scannerBox(choices, "store", url => location.assign(url));
      choices.insertAdjacentHTML("beforeend", '<div class="picker-links"><a href="/shop/">相手を選ぶ画面を開く</a><a href="/communities/">コミュニティを見る</a></div>');
      content.querySelector(".home-send").onclick = e => { e.preventDefault(); picker.showModal(); };
    }
    const origins = [...s.funds].map(([id, n]) => `<p>${h(by(id)?.name || id)}：${n} WARA</p>`).join("") || "<p>まだWARAはありません。</p>";
    if (path === "/account") {
      content.insertAdjacentHTML("beforeend", `<details id="origins"><summary>WARAの発行元</summary>${origins}</details>`);
    } else {
      const breakdown = document.createElement("div");
      breakdown.id = "origins";
      breakdown.innerHTML = origins;
      const update = document.createElement("button");
      update.type = "button";
      update.className = "secondary";
      update.textContent = "状態を更新";
      const dialog = dialogPanel(content, "WARAの発行元内訳", [breakdown, update]);
      update.onclick = () => { dialog.close(); void recover(); void refresh(true); };
      content.querySelector(".top-counters a").onclick = e => { e.preventDefault(); dialog.showModal(); };
    }
  }
  if (path === "/communities/new") {
    newGroup();
    return;
  }
  ui(path === "/" || path === "/user" ? twinCards(null, true) : "<p>Devnetの最新状態を確認しています…</p>");
  const reload = document.createElement("button");
  reload.textContent = "更新";
  reload.className = "secondary";
  reload.hidden = stage;
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
