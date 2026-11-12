import { registerChoices } from "../shop-directory.mjs";
import { shopTitle, shopDetails, shopEditor } from "../shop-profile.mjs";
import { memoFields, bindMemoChips } from "../memo-ui.mjs";
import { paymentMemo } from "../../shared/payment-memo.mjs";
import { twinCards, crystallize } from "../balances.mjs";
import { showHistory } from "../history.mjs";
import { invoiceAmount, scannerBox } from "../scan.mjs";
import QRCode from "qrcode";
import { program, linked } from "../network.mjs";
import { spend, transfer, split } from "../protocol.mjs";
import { confirmDialog } from "../confirm-dialog.mjs";
import { amount, receipt, short } from "./ui.mjs";

export function shopView(ctx) {
  const { state, content, params, who, profile, profiles, ui, form, btn, inp, link,
    gid, register, by, shopName, send, view, refresh, h, info, action,
    readHistory, recordPayment, registerWatch } = ctx;
  function store() {
    const s = state();
    const groupForShop = id => by(id) || s.rows.find(row=>row.tag === 31 && row.id === id);
    const stores = s.rows.filter(r => r.tag === 32 && (r.to === who ||
      (by(r.group) && (by(r.group).visibility !== "private" || by(r.group).joined)))),
      g = groupForShop(params.get("group")),
      store = stores.find(
        (r) => r.group === g?.id && r.to === params.get("store"),
      );
    if (!store) {
      const receiving = params.get("mode") === "receive";
      const choices = registerChoices(stores, s, who, receiving);
      ui(
        "<section><h2>" + (receiving ? "自分の店舗レジ" : "店のレジを選ぶ") + "</h2>" +
          choices
            .map(
              (st) =>
                "<p>" +
                `<a href="${h(register(st.group, st.to))}" data-shop-label="${h(st.id)}">${h(shopTitle(st))}${shopDetails(st,h)}</a>` +
                " · " +
                h(groupForShop(st.group)?.name) +
                "</p>",
            )
            .join("") +
          (choices.length ? "" : receiving ? "<p>この財布に登録された公認店舗はありません。</p>" : "<p>参加中のコミュニティに公認店舗はまだありません。</p>") +
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
      twinCards(s) + `<section><h2 data-shop-label="${h(store.id)}">` +
        h(shopTitle(store)) + shopDetails(store,h) +
        "</h2><small>" +
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
        const {payWithCard}=await import("../member-ui.mjs");
        const sig=await payWithCard(g.id,store.to,Number(v.amount),store.name,paymentMemo(v.memo));
        const refreshed = await refresh(true);
        info("紙カードの支払いが確定しました。" + (refreshed ? "" : " 残高は再度更新してください。"));
        const a = document.createElement("a");
        a.href = receipt(sig); a.textContent = " Devnetの取引を見る"; a.target = "_blank"; a.rel = "noopener";
        document.querySelector("#notice").append(a);
      });
    }
    if (isShop) showHistory(content, readHistory, g.id, h, by, shopName);
    form("invoice", async (v) => {
      registerWatch.stop();
      const qrBox = content.querySelector("#qr");
      const qrDisplay = document.createElement("article");
      qrDisplay.id = "qr-out";
      qrDisplay.hidden = true;
      qrBox.replaceChildren(qrDisplay);
      const u = new URL(register(g.id, store.to), location.origin);
      u.searchParams.set("ina", String(amount(v.ina)));
      const qr = await QRCode.toDataURL(u.href);
      if (!qrDisplay.isConnected) return;
      const watching = await registerWatch.start({
        element: qrDisplay, address: store.to, group: g.id,
        onPayment: async rows => {
          recordPayment();
          const ina = rows.filter(row => row.kusa).reduce((sum, row) => sum + row.n, 0n);
          const wara = rows.filter(row => !row.kusa).reduce((sum, row) => sum + row.n, 0n);
          if (ina) crystallize(ina, true);
          else crystallize(wara, true, "wara");
          await readHistory(); // Finish any older in-flight history read before remounting.
          const refreshed = await refresh(true);
          info("着金を確認しました。" + (refreshed ? "" : " 残高と履歴は「更新」で再確認してください。"));
        },
        onError: () => info("着金を照会できません。自動で再試行します。"),
      });
      if (!watching) return;
      qrDisplay.innerHTML =
        '<img alt="支払い用QR" src="' +
        qr +
        '"><p>' +
        h(v.ina) +
        " INA · " +
        h(store.name) +
        "</p>" +
        link(u.href, "会計リンク");
      qrDisplay.hidden = false;
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
        !await confirmDialog({ title: "INAのお支払いを確認", message:
          store.name +
            "へ " +
            n +
            " INA。店に " +
            n * 90n +
            " WARA、あなたに " +
            n * 10n +
            " WARA。" + (memo ? "\n💬「" + memo + "」\n" : "") + "支払いますか？", confirmLabel: "支払う" })
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
      );
    });
    form("wara", async (v) => {
      const n = amount(v.amount),
        selected = split(lots, n);
      if (!await confirmDialog({ title: "WARAのお支払いを確認", message: store.name + "へ\n" + n + " WARAを支払いますか？", confirmLabel: "支払う" })) {
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
  return store;
}
