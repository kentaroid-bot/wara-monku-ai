import { Keypair } from "@solana/web3.js";
import { showHistory } from "./history.mjs";
import { scannerBox } from "./scan.mjs";
import QRCode from "qrcode";
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
  metadata,
  pk,
  createGroup,
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
  const { el, info, path, profile, wallet, action, esc: h } = ctx,
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
  let s = null;
  const refresh = async (force = false) => {
    info("Devnetを読み込み中…");
    try {
      s = await loadState(who, force);
      if (pendingSig(who)) await checkPending(who);
      view();
      info("");
    } catch (e) {
      info("取得できません：" + e.message);
    }
  };
  const send = async (ix, extra = [], msg = "取引が確定しました。") => {
    const sig = await submit(profile, wallet, ix, extra);
    await refresh(
      ix.some(
        (i) =>
          i.programId.equals(program) && i.data[0] >= 10 && i.data[0] <= 13,
      ),
    );
    info(msg);
    const a = document.createElement("a");
    a.href = receipt(sig);
    a.textContent = " Devnetの取引を見る";
    a.target = "_blank";
    a.rel = "noopener";
    document.querySelector("#notice").append(a);
    return sig;
  };
  const by = (id) => s.groups.find((g) => g.id === id);
  const outgoing = (a, b) =>
    s.rows.some(
      (r) => r.tag === 34 && r.group === a && r.to === b && r.status === 1,
    );
  function newGroup() {
    ui(
      '<p>開設したウォレットが最初の管理者になります。名称と説明はDevnet上に公開されます。</p><form id="create">' +
        inp("name", "名称", 'maxlength="50"') +
        '<label>説明<textarea name="description" maxlength="140"></textarea></label>' +
        sel("category", "カテゴリ", categories.map((c) => opt(c, c)).join("")) +
        sel("mode", "参加方式", modes.map((v, i) => opt(i, v)).join("")) +
        btn("署名して開設する") +
        "</form>",
    );
    form("create", async (v) => {
      const group = Keypair.generate(),
        mode = Number(v.mode),
        secret = mode === 1 ? inviteSecret() : null,
        inv = secret ? codeKey(secret).publicKey : who;
      const meta = metadata(v.name, v.description, v.category);
      const ix = createGroup(
        program,
        who,
        group.publicKey,
        mode,
        inv,
        meta,
        await rpc.getMinimumBalanceForRentExemption(66 + meta.length),
      );
      // Preserve the generated invitation locally across a timeout; it is never sent as transaction data.
      const id = String(group.publicKey);
      if (secret) sessionStorage.setItem("wara.invite." + id, secret);
      await send(ix, [group], "コミュニティを開設しました。");
      location.assign(gid(id));
    });
  }
  function community() {
    const id = params.get("id"),
      g = by(id);
    if (!id) {
      ui(
        link("/communities/new/", "コミュニティを開設") +
          "<section><h2>コミュニティ一覧</h2>" +
          (s.groups
            .map(
              (g) =>
                "<p>" +
                link(gid(g.id), g.name) +
                " · " +
                h(g.category) +
                " / " +
                modes[g.mode] +
                "</p>",
            )
            .join("") || "まだ登録がありません。") +
          "</section>",
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
    if (!owner && !own)
      out +=
        '<form id="join">' +
        (g.mode === 1 ? inp("code", "招待コード", 'autocomplete="off"') : "") +
        btn(g.mode === 2 ? "参加を申請する" : "この地域に参加する") +
        "</form>";
    if (owner && g.mode === 1) {
      const secret = sessionStorage.getItem("wara.invite." + g.id);
      if (secret)
        out +=
          '<details><summary>招待コードを表示</summary><p class="wrap">' +
          h(secret) +
          "</p><small>このタブを閉じる前に控えて、招待したい人にだけ渡してください。</small></details>";
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
          (r) => "<p>" + link(register(g.id, r.to), r.name + "のレジ") + "</p>",
        )
        .join("") || "<p>まだ公認店舗はありません。</p>") +
      "</section>";
    if (owner)
      out +=
        '<form id="certify"><h2>店舗を公認</h2>' +
        inp("name", "店舗名", 'maxlength="40"') +
        inp(
          "merchant",
          "店舗の受取ウォレット",
          'placeholder="店舗のアカウント画面にある公開アドレス"',
        ) +
        btn("公認してレジを作る") +
        "</form>";
    out +=
      "<section><h2>通貨同盟</h2><p>双方が承認した地域のWARAを額面どおり受け入れます。</p>" +
      s.groups
        .filter((p) => p.id !== id)
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
    form("join", async (v) => {
      const inv = g.mode === 1 ? codeKey(v.code) : null;
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
    const stores = s.rows.filter((r) => r.tag === 32 && by(r.group)),
      g = by(params.get("group")),
      store = stores.find(
        (r) => r.group === g?.id && r.to === params.get("store"),
      );
    if (!store) {
      ui(
        "<section><h2>店のレジを選ぶ</h2>" +
          stores
            .map(
              (st) =>
                "<p>" +
                link(register(st.group, st.to), st.name) +
                " · " +
                h(by(st.group).name) +
                "</p>",
            )
            .join("") +
          (stores.length ? "" : "<p>公認店舗はまだありません。</p>") +
          link("/communities/", "コミュニティを見る") +
          "</section>",
      );
      scannerBox(content, "store", (url) => location.assign(url));
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
    const fixed = params.get("kusa") || "1",
      n = /^([1-9]|10)$/.test(fixed) ? fixed : "1";
    ui(
      "<section><h2>" +
        h(store.name) +
        "</h2><small>" +
        h(g.name) +
        "の公認店舗 · " +
        h(short(store.to)) +
        "</small></section>" +
        (isShop
          ? '<form id="invoice"><h2>お会計QRを作る</h2>' +
            inp(
              "kusa",
              "金額（Kusa）",
              'type="number" min="1" max="10" value="' + n + '"',
            ) +
            btn("支払い用QRを表示") +
            '</form><div id="qr"></div>'
          : '<form id="kusa"><h2>今日のKusaで支払う</h2><p>残り ' +
            s.remaining +
            " Kusa · 1枚につき店に90 WARA、あなたに10 WARA</p>" +
            inp(
              "kusa",
              "枚数",
              'type="number" min="1" max="10" value="' + n + '"',
            ) +
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
    if (isShop) showHistory(content, who, g.id, h, by);
    form("invoice", async (v) => {
      const u = new URL(register(g.id, store.to), location.origin);
      u.searchParams.set("kusa", String(amount(v.kusa)));
      const qr = await QRCode.toDataURL(u.href);
      content.querySelector("#qr").innerHTML =
        '<article><img alt="支払い用QR" src="' +
        qr +
        '"><p>' +
        h(v.kusa) +
        " Kusa · " +
        h(store.name) +
        "</p>" +
        link(u.href, "会計リンク") +
        "</article>";
      info("お客さんのカメラで読み取ってください。");
    });
    form("kusa", async (v) => {
      const n = amount(v.kusa);
      if (!member) throw Error("地域に参加してください。");
      if (n > s.remaining) throw Error("残りKusaを超えています。");
      if (
        !confirm(
          store.name +
            "へ " +
            n +
            " Kusa。店に " +
            n * 90n +
            " WARA、あなたに " +
            n * 10n +
            " WARA。支払いますか？",
        )
      ) {
        info("取り消しました。");
        return;
      }
      await send(
        spend(program, who, g.id, store.to, n, s.day, s.nonce),
        [],
        "支払い完了。店に " +
          n * 90n +
          " WARA、客に " +
          n * 10n +
          " WARA還付。",
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
      );
    });
  }
  function view() {
    if (path === "/communities/new") return newGroup();
    if (path === "/communities") return community();
    if (path === "/shop") return store();
    const total = [...s.funds.values()].reduce((a, b) => a + b, 0n);
    ui(
      '<section class="balance"><h2>今日使えるKusa</h2><div class="amount">' +
        s.remaining +
        ' Kusa</div><span class="leaves" aria-hidden="true">' +
        "❧".repeat(Number(s.remaining)) +
        '</span><p>毎日、日本時間0時に10枚へ。使っていない分は繰り越しません。</p></section><section><h2>持っているWARA</h2><div class="amount">' +
        total +
        " WARA</div><details><summary>発行元の内訳</summary>" +
        [...s.funds]
          .map(([id, n]) => "<p>" + h(by(id)?.name) + "：" + n + " WARA</p>")
          .join("") +
        "</details></section>" +
        link("/shop/", "レジで支払う") +
        link("/communities/", "地域に参加する"),
    );
    scannerBox(content, "store", (url) => location.assign(url));
    showHistory(content, who, null, h, by);
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
  await refresh();
}
