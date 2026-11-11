import { managedSession } from "./identity.mjs";
import { shopWalletAccess } from "./shop-profile.mjs";

export function shopRequestAPI(profile, wallet) {
  const auth = shopWalletAccess(profile, wallet, "shop-requests");
  function authorization() {
    if (!profile.managed) return auth.token() && "ShopRequest " + auth.token();
    const active = managedSession();
    if (active?.profile.address !== profile.address) throw Error("もう一度サインインしてください。");
    return "Bearer " + active.session;
  }
  async function request(method, group, fields = {}) {
    const headers = {Authorization:authorization()};
    const options = {method, headers, redirect:"error", cache:"no-store", signal:AbortSignal.timeout(15000)};
    let url = "/api/v3/shop-requests";
    if (method === "GET") url += "?" + new URLSearchParams({group, ...fields});
    else {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify({group,...fields});
    }
    const response = await fetch(url, options);
    if (!response.ok) {
      const detail = await response.json().catch(()=>({}));
      throw Error(detail.error || "申請の状態を取得できません。「更新」で確認してください。");
    }
    return response.json();
  }
  return {authorization, authenticate:auth.authenticate, request};
}

// The panel refreshes independently so a queue error never hides the community.
// A detached panel cannot replace a newer screen or keep polling after navigation.
export function requestPanel(panel, {api, group, who, owner, esc, certify, info, register}) {
  let busy = false, snapshot = "", timer;
  let rows = [];
  const status = document.createElement("p");
  status.setAttribute("role","status");
  const body = document.createElement("div");
  panel.append(body,status);

  function render(certified) {
    const mine = rows.find(r=>r.merchant === who);
    const own = certified ? `<a class="action" href="${esc(register(group,who))}">自分のレジを開く</a>`
      : mine ? `<p>申請中：${esc(mine.title)}のレジ（管理者の公認待ち）</p>`
      : `<form data-apply><label>希望の店舗名（最大40文字）<input name="title" required></label>
         <small>公認されると店舗名が公開台帳に記録されます。</small><button>お店の開設を申請する</button></form>`;
    const list = owner && rows.length ? `<h3>店舗の開設申請（${rows.length}件）</h3>` +
      rows.map((r,i)=>`<article><strong>🏪 ${esc(r.title)}</strong>
        <p title="${esc(r.merchant)}">申請者：${esc(r.merchant.slice(0,5))}…${esc(r.merchant.slice(-5))}</p>
        <button type="button" data-certify="${i}">公認してレジを作る</button>
        <button type="button" class="secondary" data-decline="${i}">見送る</button></article>`).join("") : "";
    const input = body.querySelector("[name=title]");
    const draft = input?.value;
    const focused = input && input === document.activeElement;
    body.innerHTML = '<h2>このコミュニティでお店（レジ）を開く</h2>' + own + list;
    const field = body.querySelector("[name=title]");
    if (field && draft) field.value = draft;
    if (field && focused) field.focus();
  }
  async function load() {
    if (!api.authorization()) {
      body.innerHTML = '<button type="button" data-identify>財布で本人確認して店舗申請を開く</button>';
      snapshot = "";
      return;
    }
    let after, certified;
    const pending = [];
    do {
      const data = await api.request("GET", group, after ? {after} : {});
      if (!panel.isConnected) return;
      pending.push(...data.requests);
      after = data.next;
      certified = data.certified;
    } while (after);
    const next = JSON.stringify([certified,pending]);
    if (next !== snapshot) {
      rows = pending;
      render(certified);
      snapshot = next;
    }
  }
  async function run(job) {
    if (busy) return;
    busy = true;
    panel.inert = true;
    try {
      status.textContent = "";
      await job();
    } catch (error) {
      status.textContent = error.message;
      if (!panel.isConnected) info(error.message);
    } finally { busy = false; panel.inert = false; }
  }
  body.onsubmit = e => {
    e.preventDefault();
    const title = e.target.elements.title.value.trim();
    void run(async()=>{
      await api.request("POST",group,{title});
      await load();
      info("申請を受け付けました。管理者の公認をお待ちください。");
    });
  };
  body.onclick = e => {
    const button = e.target.closest("button[type=button]");
    if (!button) return;
    if (button.hasAttribute("data-identify")) {
      void run(async()=>{await api.authenticate(); await load();});
      return;
    }
    const approve = button.hasAttribute("data-certify");
    const row = rows[Number(approve ? button.dataset.certify : button.dataset.decline)];
    if (!row) return;
    void run(async()=>{
      if (approve) {
        const latest = await api.request("GET",group,{merchant:row.merchant});
        if (!latest.requests.some(r=>r.request_id === row.request_id)) {
          await load(); throw Error("この申請は既に処理されています。");
        }
        await certify(row);
        // The chain is authoritative. A lost cleanup request is retried by the next GET.
        try { await api.request("DELETE",group,{...row,result:"certified"}); }
        catch { info("公認は確定しました。申請一覧は次の更新で整理されます。"); }
      } else {
        await api.request("DELETE",group,{...row,result:"declined"});
        await load();
        info("申請を見送りました。");
      }
    });
  };
  const poll = async () => {
    if (!panel.isConnected) { clearInterval(timer); return; }
    if (!document.hidden && !body.contains(document.activeElement)) await run(load);
  };
  timer = setInterval(poll, 60000);
  void run(load);
}
