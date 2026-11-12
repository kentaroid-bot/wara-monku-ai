import { memberApi } from "../member-ui.mjs";
import { joinedGroupIds, listedGroups } from "../shop-directory.mjs";
import { requestPanel } from "../shop-requests.mjs";
import { shopTitle, shopDetails } from "../shop-profile.mjs";
import { Keypair } from "@solana/web3.js";
import QRCode from "qrcode";
import { communityOpening, communityUpdate } from "../../shared/community-metadata.mjs";
import { makePolicy, rememberInvite, currentInvite, invitationUrl } from "../community-privacy.mjs";
import { inviteSecret } from "../identity.mjs";
import { program, rpc, codeKey } from "../network.mjs";
import { categories, modes, pk, certify, join, offer } from "../protocol.mjs";
import { scannerBox } from "../scan.mjs";
import { confirmDialog } from "../confirm-dialog.mjs";

export function communityViews(ctx) {
  const { state, content, params, who, profile, requests, ui, form, btn, inp, sel,
    opt, link, gid, register, by, outgoing, send, view, h, info, action } = ctx;
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
    const s = state();
    const id = params.get("id"),
      g = by(id);
    if (!id) {
      const groups = listedGroups(s.groups), joined = joinedGroupIds(s, who);
      const privateGroups = groups.filter(g => g.visibility === "private" && g.joined);
      ui(
        `<section><div class="section-head"><h2>地域のコミュニティ</h2><a href="/communities/new/">＋ 開設</a></div>
          ${groups.filter(g => g.visibility !== "private").map(g => {
            const stores = s.rows.filter(r => r.tag === 32 && r.group === g.id);
            return `<article class="market-row"><a href="${h(gid(g.id))}"><strong>${h(g.name)}</strong></a>
              <small>${h(g.category)} · ${modes[g.mode]} · 公認店舗 ${stores.length}店${joined.has(g.id) ? " · 参加中" : ""}</small>
              ${stores.map(st => `<a class="shop-row" href="${h(register(g.id, st.to))}"><span data-shop-label="${h(st.id)}">${h(shopTitle(st))}${shopDetails(st,h)}</span><small>レジを開く ›</small></a>`).join("")}</article>`;
          }).join("") || "<p>まだ登録がありません。</p>"}</section>
        ${privateGroups.length ? '<section><h2>自分の限定公開コミュニティ</h2>' +
          privateGroups.map(g => link(gid(g.id), g.name)).join("") + '</section>' : ''}`,
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
    const admitted = Boolean(g.joined || own?.status === 2);
    const shops = s.rows.filter((r) => r.tag === 32 && r.group === g.id);
    let out =
      "<section><h2>" +
      h(g.name) +
      "</h2><p>" +
      h(g.description) +
      "</p><small>" +
      h(g.category) +
      " · " +
      (g.mode === 1 ? "新規参加は招待制" : modes[g.mode]) +
      " · " +
      (owner
        ? "あなたは管理者"
        : admitted
          ? "参加中"
          : own?.status === 1
            ? "参加申請中"
            : g.nameUnavailable ? "参加状況を確認できません" : "未参加") +
      "</small></section>";
    if (!owner && !admitted && !g.nameUnavailable && (!own || (own.status === 1 && g.mode !== 2)))
      out +=
        '<form id="join">' +
        (g.mode === 1 ? inp("code", "招待コード", 'autocomplete="off"') : "") +
        btn(g.mode === 2 ? "参加を申請する" : "この地域に参加する") +
        "</form>";
    const secret = currentInvite(g, who);
    const privateNameEditor = owner && profile.managed && g.visibility === "private";
    if (owner) {
      const locked = g.visibility === "private" && !g.unlocked;
      if (privateNameEditor && !g.nameUnavailable) {
        const currentName = g.unlocked || g.nameRevision ? g.name : "";
        out += '<form id="private-name"><h2>コミュニティ名の変更</h2>' +
          inp("name", "コミュニティ名", 'maxlength="50" value="' + h(currentName) + '"') +
          btn("名前を保存") + '</form>';
      }
      const needsName = !privateNameEditor || (locked && !g.nameRevision);
      const editFields = (locked ? '<p>招待リンクの再発行には、名称と説明を確認してください。</p>' : '') +
        (needsName ? inp("name", "コミュニティ名", 'maxlength="50" value="' + h(locked ? "" : g.name) + '"') : '') +
        '<label>説明<textarea name="description" maxlength="140">' + h(g.description || "") + '</textarea></label>' +
        sel("category", "カテゴリ", categories.map(c => opt(c, c)).join(""));
      out += '<form id="policy"><h2>コミュニティの設定</h2>' + policyFields() + editFields +
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
          (r) => `<p><a class="action" href="${h(register(g.id,r.to))}"><span data-shop-label="${h(r.id)}" data-register-label="1">${h(shopTitle(r))}のレジ${shopDetails(r,h)}</span></a></p>`,
        )
        .join("") || "<p>まだ公認店舗はありません。</p>") +
      "</section>";
    if (owner || admitted) out += '<section data-shop-requests></section>';
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
    if (!owner && !admitted)
      out += '<section><h2>お店（レジ）を開きたい方へ</h2><p>コミュニティに参加すると、この画面から店舗の開設を申請できます。</p></section>';
    const peers = s.groups
      .filter((p) => p.id !== id && p.visibility !== "private")
      .map((p) => ({ ...p, sent: outgoing(id, p.id), received: outgoing(p.id, id) }));
    const partners = peers.filter((p) => p.sent && p.received);
    const treatyRow = (p, status, label, enable) =>
      "<article>" + h(p.name) + " · " + status +
      (owner
        ? '<form class="treaty"><input type="hidden" name="peer" value="' + h(p.id) +
          '"><input type="hidden" name="enable" value="' + enable + '">' + btn(label) + "</form>"
        : "") + "</article>";
    out +=
      "<section><h2>通貨同盟（提携地域）</h2><p>双方が承認した地域のWARAを額面どおり受け入れます。</p>" +
      (partners.map((p) => treatyRow(p, "提携中", "提携を解除", "0")).join("") ||
        "<p>提携中の地域はありません</p>");
    if (owner) {
      const incoming = peers.filter((p) => !p.sent && p.received),
        pending = peers.filter((p) => p.sent && !p.received),
        available = peers.filter((p) => !p.sent && !p.received);
      if (incoming.length)
        out += "<h3>提携の申請が届いています</h3>" +
          incoming.map((p) => treatyRow(p, "承認待ち", "提携を承認", "1")).join("");
      if (pending.length)
        out += "<h3>申請中（相手の承認待ち）</h3>" +
          pending.map((p) => treatyRow(p, "申請中（相手の承認待ち）", "申請を取り消す", "0")).join("");
      out += '<details><summary>他の地域へ提携を申請</summary>' +
        (available.length
          ? '<form class="treaty">' +
            sel("peer", "申請先の地域", available.map((p) => opt(p.id, p.name)).join("")) +
            '<input type="hidden" name="enable" value="1">' + btn("提携を申請") + "</form>"
          : "<p>申請可能な公開地域はありません</p>") + "</details>";
    }
    out += "</section>";
    ui(out);
    const requestBox = content.querySelector("[data-shop-requests]");
    if (requestBox) requestPanel(requestBox, {api:requests, group:id, who, owner, esc:h, info, register,
      certify: row => send([certify(program, who, id, pk(row.merchant), row.title)], [], "店舗を公認してレジを開設しました。"),
    });
    if (owner) {
      if (privateNameEditor) form("private-name", async ({name}) => {
        const saved = await memberApi("community-rename", {
          group:id, invite:g.invite, sealed:g.sealed, name, revision:g.nameRevision || 0,
        });
        Object.assign(g, saved);
        view();
        info("名前を保存しました。参加者にも新しい名前が表示されます。");
      });
      const f = content.querySelector("#policy");
      f.elements.visibility.value = g.visibility;
      f.elements.mode.value = String(g.mode);
      if (f.elements.category && g.category) f.elements.category.value = g.category;
      const change = async (v, rotate) => {
        const mode = Number(v.mode), visibility = v.visibility;
        const name = (v.name ?? g.name ?? "").trim();
        const description = (v.description ?? g.description ?? "").trim();
        const category = v.category || g.category;
        if (!rotate && mode === g.mode && visibility === g.visibility && name === (g.name || "") && description === (g.description || "") && category === (g.category || "")) throw Error("変更する設定を選んでください。");
        const warning = g.visibility === "private" && visibility === "public"
          ? "名称・説明を公開します。台帳に公開した内容は消去できません。"
          : "現在の参加用リンクは更新されます。既存の参加者はそのままです。";
        if (!await confirmDialog({ title: "コミュニティの設定を確認", message: warning + "\n設定を更新しますか？", confirmLabel: "設定を更新" })) { info("取り消しました。"); return; }
        const next = await makePolicy({...g, ...v, name, description, category, mode, visibility}, id, who, inviteSecret);
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
  return { newGroup, community };
}
