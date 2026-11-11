import { requestPanel, shopRequestAPI } from "./shop-requests.mjs";
import { shopProfiles, shopTitle, shopDetails, shopEditor } from "./shop-profile.mjs";
import { memoFields, bindMemoChips } from "./memo-ui.mjs";
import { paymentMemo } from "../shared/payment-memo.mjs";
import { twinCards, crystallize } from "./balances.mjs";
import { Keypair } from "@solana/web3.js";
import { showHistory } from "./history.mjs";
import { invoiceAmount, scannerBox } from "./scan.mjs";
import QRCode from "qrcode";
import { communityOpening, communityUpdate } from "../shared/community-metadata.mjs";
import { makePolicy, rememberInvite, currentInvite, pendingInvite, invitationUrl } from "./community-privacy.mjs";
import { inviteSecret } from "./identity.mjs";
import {
  program,
  rpc,
  loadState,
  linked,
  codeKey,
  submit,
  checkPending,
  pendingSig,
} from "./network.mjs";
import {
  categories,
  modes,
  pk,
  certify,
  join,
  offer,
  spend,
  transfer,
  split,
} from "./protocol.mjs";
const amount = (s) => {
  if (!/^[1-9][0-9]{0,14}$/.test(s))
    throw Error("1以上の整数で入力してください。");
  return BigInt(s);
};
const receipt = (sig) =>
  "https://explorer.solana.com/tx/" +
  encodeURIComponent(sig) +
  "?cluster=devnet";
const short = (s) => s.slice(0, 5) + "…" + s.slice(-5);
export async function dashboard(ctx) {
  const { el, info, path, profile, wallet, action, recordPayment, readHistory, esc: h } = ctx,
    who = profile.address,
    params = new URLSearchParams(location.search);
  const content = document.createElement("div");
  el.append(content);
  const ui = (s) => (content.innerHTML = s);
  const form = (id, fn) => action(content.querySelector("#" + id), fn);
  const btn = (text) => "<button>" + text + "</button>";
  const inp = (name, label, attrs = "") =>
    "<label>" +
    label +
    '<input name="' +
    name +
    '" ' +
    attrs +
    " required></label>";
  const sel = (name, label, list) =>
    "<label>" +
    label +
    '<select required name="' +
    name +
    '">' +
    list +
    "</select></label>";
  const opt = (id, text) =>
    '<option value="' + h(id) + '">' + h(text) + "</option>";
  const link = (path, text) =>
    '<a class="action" href="' + h(path) + '">' + h(text) + "</a>";
  const gid = (id) => "/communities/?id=" + encodeURIComponent(id);
  const register = (g, shop) =>
    "/shop/?" + new URLSearchParams({ group: g, store: shop });
  const profiles = shopProfiles(profile, wallet);
  const requests = shopRequestAPI(profile, wallet);
  let s = null;
  const refresh = async (force = false) => {
    info("Devnetを読み込み中…");
    try {
      const requestedShop = path === "/shop" && params.has("group") && params.has("store")
        ? {group:params.get("group"), store:params.get("store")} : null;
      s = await loadState(who, force, requestedShop);
      let profileError = "";
      try { await profiles.load(s); }
      catch { profileError = "店舗プロフィールを取得できません。「更新」で再試行できます。"; }
      if (pendingSig(who)) await checkPending(who);
      view();
      info(profileError);
      return true;
    } catch (e) {
      ui("<p>最新の状態を表示できません。「更新」で再確認してください。</p>");
      info("取得できません：" + e.message);
      return false;
    }
  };
  const send = async (ix, extra = [], msg = "取引が確定しました。", onConfirmed) => {
    const sig = await submit(profile, wallet, ix, extra);
    onConfirmed?.();
    const refreshed = await refresh(
      ix.some(
        (i) =>
          i.programId.equals(program) && ((i.data[0] >= 10 && i.data[0] <= 13) || i.data[0] === 17),
      ),
    );
    info(msg + (refreshed ? "" : " 残高は「更新」で再確認してください。"));
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
  const policyFields = () => sel("visibility", "公開範囲", opt("public", "公開（市場に掲載）") + opt("private", "限定公開（リンク限定）")) +
    sel("mode", "参加方式", modes.map((v, i) => opt(i, v)).join(""));
  function newGroup() {
    ui(
      '<p>開設したウォレットが最初の管理者になります。公開を選ぶと名称と説明がDevnetに掲載されます。開設者はコミュニティ口座の作成費とMetaplexの登録料をDevnet SOLで支払います。手数料支援が有効なときはトークン情報の口座保管料と取引手数料を運営が負担します。</p><form id="create">' +
        policyFields() +
        inp("name", "名称", 'maxlength="50"') +
        '<label>説明<textarea name="description" maxlength="140"></textarea></label>' +
        sel("category", "カテゴリ", categories.map((c) => opt(c, c)).join("")) +
        btn("署名して開設する") +
        "</form>",
    );
    form("create", async (v) => {
      const group = Keypair.generate(), id = String(group.publicKey);
      const policy = await makePolicy({...v, mode:Number(v.mode)}, id, who, inviteSecret);
      const ix = communityOpening(program, who, id, policy.mode, policy.invite, policy.bytes,
        await rpc.getMinimumBalanceForRentExemption(66 + policy.bytes.length));
      if (policy.code) rememberInvite(id, who, policy.code);
      await send(ix, [group], "コミュニティを開設しました。");
      location.assign(gid(id));
    });
  }
  function community() {
    const id = params.get("id"),
      g = by(id);
    if (!id) {
      ui(
        `<section><div class="section-head"><h2>地域のコミュニティ</h2><a href="/communities/new/">＋ 開設</a></div>
          ${s.groups.filter(g => g.visibility !== "private").map(g => {
            const stores = s.rows.filter(r => r.tag === 32 && r.group === g.id);
            const joined = g.owner === who || s.rows.some(r => r.tag === 33 && r.group === g.id && r.to === who && r.status === 2);
            return `<article class="market-row"><a href="${h(gid(g.id))}"><strong>${h(g.name)}</strong></a>
              <small>${h(g.category)} · ${modes[g.mode]} · 公認店舗 ${stores.length}店${joined ? " · 参加中" : ""}</small>
              ${stores.map(st => `<a class="shop-row" href="${h(register(g.id, st.to))}"><span>${h(shopTitle(st))}${shopDetails(st,h)}</span><small>レジを開く ›</small></a>`).join("")}</article>`;
          }).join("") || "<p>まだ登録がありません。</p>"}</section>
        ${s.groups.some(g => g.visibility === "private" && g.joined) ? '<section><h2>自分の限定公開コミュニティ</h2>' +
          s.groups.filter(g => g.visibility === "private" && g.joined).map(g => link(gid(g.id), g.name)).join("") + '</section>' : ''}`,
      );
      return;
    }
    if (!g) {
      ui("<p>このコミュニティは見つかりません。</p>");
      return;
    }
    const owner = g.owner === who,
      own = s.rows.find(
        (r) => r.tag === 33 && r.group === g.id && r.to === who,
      );
    const shops = s.rows.filter((r) => r.tag === 32 && r.group === g.id);
    let out =
      "<section><h2>" +
      h(g.name) +
      "</h2><p>" +
      h(g.description) +
      "</p><small>" +
      h(g.category) +
      " · " +
      modes[g.mode] +
      " · " +
      (owner
        ? "あなたは管理者"
        : own?.status === 2
          ? "参加中"
          : own?.status === 1
            ? "参加申請中"
            : "未参加") +
      "</small></section>";
    if (!owner && (!own || (own.status === 1 && g.mode !== 2)))
      out +=
        '<form id="join">' +
        (g.mode === 1 ? inp("code", "招待コード", 'autocomplete="off"') : "") +
        btn(g.mode === 2 ? "参加を申請する" : "この地域に参加する") +
        "</form>";
    const secret = currentInvite(g, who);
    if (owner) {
      const locked = g.visibility === "private" && !g.unlocked;
      const recover = locked ? '<p>この端末には現在の招待鍵がありません。控えたリンクを開くか、名称・説明を再入力して新しいリンクを発行してください。</p>' +
        inp("name","コミュニティ名") + '<label>説明<textarea name="description"></textarea></label>' +
        sel("category","カテゴリ", categories.map(c => opt(c,c)).join("")) : "";
      out += '<form id="policy"><h2>コミュニティの設定</h2>' + policyFields() + recover +
        '<p>設定を変更すると、共有リンクは新しくなります。これまで公開した名称や取引の記録は台帳に残ります。トークンと既存の参加資格は変わりません。保存容量が増える場合、追加の口座保管料は管理者が支払います。</p>' +
        btn(locked ? "設定を更新してリンクを再発行" : "署名して設定を更新") + '</form>';
      if (g.mode === 1 && !locked)
        out += '<form id="rotate">' + btn("招待コードを再発行") + '</form>';
      if ((g.visibility === "private" || g.mode === 1) && secret) {
        const url = h(invitationUrl(g.id, secret));
        out += '<section data-invite><h2>参加用リンク・QRコード</h2><img alt="このコミュニティの参加用QRコード"><p><a class="wrap" href="' +
          url + '">' + url + '</a></p><button type="button">URLをコピー</button>' +
          (g.mode === 1 ? '<details><summary>招待コードを表示</summary><p class="wrap">' + h(secret) + '</p></details>' : '') +
          '<p>共有したい相手にだけ渡してください。' + (g.mode === 2 ? '参加には管理者の承認が必要です。' : '') + '</p></section>';
      } else if (g.mode === 1 && !locked) {
        out += '<p>この端末に招待コードがありません。元のリンクを開くか、再発行してください。</p>';
      }
    }
    if (owner && g.mode === 2)
      out += s.rows
        .filter((r) => r.tag === 33 && r.group === g.id && r.status === 1)
        .map(
          (r) =>
            '<form class="approve"><p class="wrap">参加希望：' +
            h(r.to) +
            '</p><input type="hidden" name="member" value="' +
            h(r.to) +
            '">' +
            btn("参加を承認する") +
            "</form>",
        )
        .join("");
    out +=
      "<section><h2>公認店舗</h2>" +
      (shops
        .map(
          (r) => "<p>" + link(register(g.id, r.to), shopTitle(r) + "のレジ") + shopDetails(r,h) + "</p>",
        )
        .join("") || "<p>まだ公認店舗はありません。</p>") +
      "</section>";
    if (owner || own?.status === 2) out += '<section data-shop-requests></section>';
    if (owner)
      out +=
        '<details><summary>直接アドレスを指定して公認</summary><form id="certify">' +
        inp("name", "店舗名", 'maxlength="40"') +
        inp(
          "merchant",
          "店舗の受取ウォレット",
          'placeholder="店舗のアカウント画面にある公開アドレス"',
        ) +
        btn("公認してレジを作る") +
        "</form></details>";
    if (!owner && own?.status !== 2)
      out += '<section><h2>お店（レジ）を開きたい方へ</h2><p>コミュニティに参加すると、この画面から店舗の開設を申請できます。</p></section>';
    out +=
      "<section><h2>通貨同盟</h2><p>双方が承認した地域のWARAを額面どおり受け入れます。</p>" +
      s.groups
        .filter((p) => p.id !== id && p.visibility !== "private")
        .map((p) => {
          const sent = outgoing(id, p.id),
            received = outgoing(p.id, id);
          return (
            "<article>" +
            h(p.name) +
            " · " +
            (sent && received
              ? "提携中"
              : sent
                ? "申請中"
                : received
                  ? "申請が届いています"
                  : "未提携") +
            (owner
              ? '<form class="treaty"><input type="hidden" name="peer" value="' +
                h(p.id) +
                '"><input type="hidden" name="enable" value="' +
                (!sent ? "1" : "0") +
                '">' +
                btn(
                  sent
                    ? "取り消す・提携を解除"
                    : received
                      ? "提携を承認"
                      : "提携を申請",
                ) +
                "</form>"
              : "") +
            "</article>"
          );
        })
        .join("") +
      "</section>";
    ui(out);
    const requestBox = content.querySelector("[data-shop-requests]");
    if (requestBox) requestPanel(requestBox, {api:requests, group:id, who, owner, esc:h, info, register,
      certify: row => send([certify(program, who, id, pk(row.merchant), row.title)], [], "店舗を公認してレジを開設しました。"),
    });
    if (owner) {
      const f = content.querySelector("#policy");
      f.elements.visibility.value = g.visibility;
      f.elements.mode.value = String(g.mode);
      const change = async (v, rotate) => {
        const mode = Number(v.mode), visibility = v.visibility;
        if (!rotate && mode === g.mode && visibility === g.visibility && !v.name) throw Error("変更する設定を選んでください。");
        const warning = g.visibility === "private" && visibility === "public"
          ? "名称・説明を公開します。台帳に公開した内容は消去できません。"
          : "現在の参加用リンクは更新されます。既存の参加者はそのままです。";
        if (!confirm(warning + " 設定を更新しますか？")) { info("取り消しました。"); return; }
        const next = await makePolicy({...g, ...v, mode, visibility}, id, who, inviteSecret);
        const ix = communityUpdate(program, who, id, g.mode, g.invite, mode, next.invite, next.bytes);
        if (next.code) rememberInvite(id, who, next.code);
        await send([ix], [], "コミュニティの設定を更新しました。");
      };
      form("policy", v => change(v, false));
      form("rotate", () => change({mode:g.mode, visibility:g.visibility}, true));
      if (secret) rememberInvite(id, who, secret);
    }
    const invitation = content.querySelector("[data-invite]");
    if (invitation) {
      const url = invitation.querySelector("a").href;
      QRCode.toDataURL(url).then(src => { invitation.querySelector("img").src = src; })
        .catch(() => info("招待URLを共有してください。"));
      invitation.querySelector("button").onclick = () => navigator.clipboard.writeText(url)
        .then(() => info("招待URLをコピーしました。")).catch(() => info("招待URLを長押ししてコピーしてください。"));
    }
    const codeInput = content.querySelector('#join [name="code"]');
    if (codeInput) {
      codeInput.value = secret || "";
      codeInput.parentElement.hidden = Boolean(codeInput.value);
    }
    form("join", async (v) => {
      const inv = g.mode === 1 ? codeKey(v.code) : null;
      if (inv && String(inv.publicKey) !== g.invite) throw Error("この招待コードは無効です。最新のリンクを管理者に依頼してください。");
      await send(
        [join(program, who, id, who, false, inv?.publicKey)],
        inv ? [inv] : [],
      );
    });
    if (owner)
      scannerBox(
        content.querySelector("#certify"),
        "card",
        (v) => (content.querySelector("#certify [name=merchant]").value = v),
      );
    form("certify", async (v) => {
      await send([certify(program, who, id, pk(v.merchant.trim()), v.name)]);
    });
    for (const f of content.querySelectorAll(".approve"))
      action(f, (v) => send([join(program, who, id, v.member, true)]));
    for (const f of content.querySelectorAll(".treaty"))
      action(f, (v) =>
        send([offer(program, who, id, v.peer, v.enable === "1")]),
      );
  }
  function store() {
    const groupForShop = id => by(id) || s.rows.find(row=>row.tag === 31 && row.id === id);
    const stores = s.rows.filter(r => r.tag === 32 && (r.to === who ||
      (by(r.group) && (by(r.group).visibility !== "private" || by(r.group).joined)))),
      g = groupForShop(params.get("group")),
      store = stores.find(
        (r) => r.group === g?.id && r.to === params.get("store"),
      );
    if (!store) {
      const receiving = params.get("mode") === "receive";
      const choices = receiving ? stores.filter(st => st.to === who) : stores;
      ui(
        "<section><h2>" + (receiving ? "自分の店舗レジ" : "店のレジを選ぶ") + "</h2>" +
          choices
            .map(
              (st) =>
                "<p>" +
                link(register(st.group, st.to), shopTitle(st)) + shopDetails(st,h) +
                " · " +
                h(groupForShop(st.group)?.name) +
                "</p>",
            )
            .join("") +
          (choices.length ? "" : receiving ? "<p>この財布に登録された公認店舗はありません。</p>" : "<p>公認店舗はまだありません。</p>") +
          link("/communities/", "コミュニティを見る") +
          "</section>",
      );
      if (!receiving) scannerBox(content, "store", (url) => location.assign(url));
      return;
    }
    const lots = [...s.funds]
      .filter(([id, n]) => n > 0n && linked(s.rows, id, g.id))
      .map(([origin, n]) => ({ origin, amount: n }))
      .sort((a, b) => Number(b.origin === g.id) - Number(a.origin === g.id));
    const accepted = lots.reduce((a, l) => a + l.amount, 0n);
    const isShop = who === store.to,
      member =
        g.owner === who ||
        s.rows.some(
          (r) =>
            r.tag === 33 && r.group === g.id && r.to === who && r.status === 2,
        );
    const n = invoiceAmount(params) || "1";
    ui(
      twinCards(s) + "<section><h2>" +
        h(shopTitle(store)) +
        "</h2>" + shopDetails(store,h) + "<small>" +
        h(g.name) +
        "の公認店舗 · " +
        h(short(store.to)) +
        "</small></section>" +
        (isShop
          ? shopEditor(store,h) + '<form id="invoice"><h2>お会計QRを作る</h2>' +
            inp(
              "ina",
              "金額（INA）",
              'type="number" min="1" max="10" value="' + n + '"',
            ) +
            btn("支払い用QRを表示") +
            '</form><div id="qr"></div>'
          : '<form id="ina"><h2>今日のINAで支払う</h2><p>残り ' +
            s.remaining +
            " INA · 1枚につき店に90 WARA、あなたに10 WARA</p>" +
            inp(
              "ina",
              "枚数",
              'type="number" min="1" max="10" value="' + n + '"',
            ) +
            (member ? memoFields : "") +
            (member
              ? btn("金額を確認して支払う")
              : link(gid(g.id), "地域に参加して支払う")) +
            "</form>" +
            '<form id="wara"><h2>持っているWARAで支払う</h2><p>この店で使えるWARA：<strong>' +
            accepted +
            " WARA</strong></p><details><summary>発行元の内訳</summary>" +
            lots
              .map(
                (l) =>
                  "<p>" + h(by(l.origin)?.name) + "：" + l.amount + " WARA</p>",
              )
              .join("") +
            "</details>" +
            inp("amount", "支払い額（WARA）", 'type="number" min="1"') +
            btn("WARAで支払う") +
            "</form>"),
    );
    if (isShop) form("edit-shop", async values => {
      const saved = await profiles.save(store,values);
      Object.assign(store,saved,{name:saved.title});
      view();
      info("店舗情報を保存しました。");
    });
    if (!profile.managed && g.visibility === "private" && !store.revision) {
      const readProfile = document.createElement("form");
      readProfile.innerHTML = btn("財布で本人確認して店舗情報を読む");
      content.append(readProfile);
      action(readProfile,async()=>{await profiles.authenticate(); await refresh();});
    }
    if (isShop && profile.managed) {
      const checkout=document.createElement("form");
      checkout.innerHTML='<h2>お客さんの紙カードで支払う</h2><label>金額（INA）<input name="amount" type="number" min="1" max="10" required></label>'+memoFields+'<button>カードを読む</button>';
      content.append(checkout);
      bindMemoChips(checkout);
      action(checkout,async v=>{
        const {payWithCard}=await import("./member-ui.mjs");
        const sig=await payWithCard(g.id,store.to,Number(v.amount),store.name,paymentMemo(v.memo));
        recordPayment();
        crystallize(BigInt(v.amount), true);
        const refreshed = await refresh(true);
        info("紙カードの支払いが確定しました。" + (refreshed ? "" : " 残高は再度更新してください。"));
        const a = document.createElement("a");
        a.href = receipt(sig); a.textContent = " Devnetの取引を見る"; a.target = "_blank"; a.rel = "noopener";
        document.querySelector("#notice").append(a);
      });
    }
    if (isShop) showHistory(content, readHistory, g.id, h, by, shopName);
    form("invoice", async (v) => {
      const u = new URL(register(g.id, store.to), location.origin);
      u.searchParams.set("ina", String(amount(v.ina)));
      const qr = await QRCode.toDataURL(u.href);
      content.querySelector("#qr").innerHTML =
        '<article><img alt="支払い用QR" src="' +
        qr +
        '"><p>' +
        h(v.ina) +
        " INA · " +
        h(store.name) +
        "</p>" +
        link(u.href, "会計リンク") +
        "</article>";
      info("お客さんのカメラで読み取ってください。");
    });
    const inaForm = content.querySelector("#ina");
    if (inaForm) bindMemoChips(inaForm);
    form("ina", async (v) => {
      const memo = paymentMemo(v.memo || "");
      const n = amount(v.ina);
      if (!member) throw Error("地域に参加してください。");
      if (n > s.remaining) throw Error("残りINAを超えています。");
      if (
        !confirm(
          store.name +
            "へ " +
            n +
            " INA。店に " +
            n * 90n +
            " WARA、あなたに " +
            n * 10n +
            " WARA。" + (memo ? "\n💬「" + memo + "」\n" : "") + "支払いますか？",
        )
      ) {
        info("取り消しました。");
        return;
      }
      await send(
        spend(program, who, g.id, store.to, n, s.day, s.nonce, memo),
        [],
        "支払い完了。店に " +
          n * 90n +
          " WARA、客に " +
          n * 10n +
          " WARA還付。",
        () => { recordPayment(); crystallize(n, false); },
      );
    });
    form("wara", async (v) => {
      const n = amount(v.amount),
        selected = split(lots, n);
      if (!confirm(store.name + "へ " + n + " WARAを支払いますか？")) {
        info("取り消しました。");
        return;
      }
      await send(
        transfer(program, who, g.id, store.to, selected),
        [],
        n + " WARAの支払いが確定しました。",
        recordPayment,
      );
    });
  }
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
  const invited = params.get("id");
  await refresh(path === "/communities" && Boolean(invited && sessionStorage.getItem(pendingInvite(invited))));
}
