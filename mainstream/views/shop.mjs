import { iineStage, bindIineGame, clampCount } from "../iine-game.mjs";
import { registerChoices } from "../shop-directory.mjs";
import { shopTitle, shopDetails, shopEditor } from "../shop-profile.mjs";
import { memoFields, bindMemoChips } from "../memo-ui.mjs";
import { paymentMemo, paymentReaction } from "../../shared/payment-memo.mjs";
import { crystallize } from "../balances.mjs";
import { showHistory } from "../history.mjs";
import { invoiceAmount, scannerBox } from "../scan.mjs";
import QRCode from "qrcode";
import { program, linked } from "../network.mjs";
import { spend, transfer, split } from "../protocol.mjs";
import { confirmDialog } from "../confirm-dialog.mjs";
import { amount, receipt, short } from "./ui.mjs";

function feedbackSummary(reaction, note) {
  return (reaction ? "\n公開する絵文字：" + reaction : "") + (note ? "\nひとこと：「" + note + "」" : "") + "\n";
}

export function shopView(ctx) {
  const { el, state, content, params, who, profile, profiles, ui, form, btn, inp, link,
    gid, register, by, shopName, send, view, refresh, h, info, action,
    readHistory, recordPayment, registerWatch } = ctx;
  const setHeading = text => {
    const h1 = el?.querySelector("h1");
    if (h1) h1.textContent = text;
  };
  const privateNotes = profile.managed || profiles.supportsNotes;
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
      setHeading(receiving ? "受け取る" : "iineを贈る");
      const choices = registerChoices(stores, s, who, receiving);
      ui(`<section><h2>${receiving ? "受け取り窓口を選ぶ" : "相手を選ぶ"}</h2>
        <p>${receiving ? "受け取り名 · コミュニティ名を選んでQRを出せます。" : `今日の残り ${s.remaining} iine`}</p>
        ${choices.map(st => `<a class="shop-row recipient-row" href="${h(register(st.group, st.to))}">
          <span><span data-shop-label="${h(st.id)}" data-compact-label="1">${h(shopTitle(st))}</span> · ${h(groupForShop(st.group)?.name || "コミュニティ")}</span>
          <strong>${receiving ? "QRを出す" : "贈る"} ›</strong></a>`).join("")}
        ${choices.length ? "" : receiving ? "<p>この財布には受け取り窓口がまだありません。</p>" : "<p>参加中のコミュニティに受け取り相手はまだいません。</p>"}
        ${link("/communities/", "コミュニティを見る")}</section>`);
      if (!receiving) scannerBox(content, "store", (url) => location.assign(url));
      return;
    }
    const lots = [...s.funds]
      .filter(([id, n]) => n > 0n && linked(s.rows, id, g.id))
      .map(([origin, n]) => ({ origin, amount: n }))
      .sort((a, b) => Number(b.origin === g.id) - Number(a.origin === g.id));
    const accepted = lots.reduce((a, l) => a + l.amount, 0n);
    const isShop = who === store.to;
    setHeading(isShop ? "受け取る" : "iineを贈る");
    const member =
        g.owner === who ||
        s.rows.some(
          (r) =>
            r.tag === 33 && r.group === g.id && r.to === who && r.status === 2,
        );
    const n = invoiceAmount(params) || "0";
    ui(`<section class="recipient-heading"><h2 data-shop-label="${h(store.id)}">${h(shopTitle(store))}${shopDetails(store,h)}</h2>
      <small>${h(g.name)} · ${h(short(store.to))}</small></section>` +
      (isShop
        ? `<section class="receive-card"><h2>受け取りQR</h2><p>このQRを相手に見せてください</p>
          <div id="qr" aria-live="polite"></div>
          <form id="invoice"><input type="hidden" name="ina" value="${n}">
            <div class="memo-chips invoice-chips">${[0,1,3,5].map(count => `<button type="button" class="secondary" data-invoice="${count}" aria-pressed="${Number(n) === count}">${count ? count + " iine" : "おまかせ（枚数指定なし）"}</button>`).join("")}</div>
            <label>枚数を指定（1〜10 iine）<input name="custom" type="number" min="1" max="10" step="1" placeholder="任意の枚数" value="${n === "0" ? "" : n}"></label>
            <button type="submit" class="secondary">QRを更新</button>
          </form><p class="muted">QRを表示している間、届いたありがとうを確認します。</p></section>` + shopEditor(store,h)
        : `<form id="ina"><p>今日の残り ${s.remaining} iine</p>` + iineStage() +
          (member ? '<button type="submit" class="send-iine" disabled>贈る</button>' + memoFields(privateNotes) : link(gid(g.id), "コミュニティに参加して贈る")) +
          '</form><details class="wara-gift"><summary>🌾 持っているWARAを贈る</summary><form id="wara"><h2>WARAを贈る</h2><p>この相手に贈れるWARA：<strong>' +
          accepted + ' WARA</strong></p><details><summary>発行元の内訳</summary>' +
          lots.map(l => '<p>' + h(by(l.origin)?.name) + '：' + l.amount + ' WARA</p>').join('') + '</details>' +
          inp("amount", "贈る数（WARA）", 'type="number" min="1"') + memoFields(privateNotes) + btn("WARAを贈る") + '</form></details>')
    );
    if (isShop) form("edit-shop", async values => {
      const saved = await profiles.save(store,values);
      Object.assign(store,saved,{name:saved.title});
      view();
      info("受け取り窓口情報を保存しました。");
    });
    if (!profile.managed && g.visibility === "private" && !store.revision) {
      const readProfile = document.createElement("form");
      readProfile.innerHTML = btn("財布で本人確認して受け取り窓口情報を読む");
      content.append(readProfile);
      action(readProfile,async()=>{await profiles.authenticate(); await refresh();});
    }
    if (isShop && profile.managed) {
      const checkout=document.createElement("form");
      checkout.className="paper-receive";
      checkout.innerHTML='<h2>紙の iineカード で受け取る</h2><p>スマホを持たない相手からも、紙カードで受け取れます。枚数を決めてカードを読み取り、暗証番号は本人に入力してもらってください。</p><label>受け取る枚数（iine）<input name="amount" type="number" min="1" max="10" value="1" required></label>'+memoFields(true)+'<button type="submit" class="paper-scan">📷 紙カードを読み取る（カメラ起動）</button><p class="muted">カメラ・写真を選んで読み取れます。</p>';
      content.append(checkout);
      bindMemoChips(checkout);
      action(checkout,async v=>{
        const {payWithCard}=await import("../member-ui.mjs");
        const sig=await payWithCard(g.id,store.to,Number(v.amount),store.name,paymentReaction(v.reaction),paymentMemo(v.memo || ""));
        const refreshed = await refresh(true);
        info("紙カードからiineを受け取りました。" + (refreshed ? "" : " 残高は再度更新してください。"));
        const a = document.createElement("a");
        a.href = receipt(sig); a.textContent = " Devnetの取引を見る"; a.target = "_blank"; a.rel = "noopener";
        document.querySelector("#notice").append(a);
      });
    }
    if (isShop) showHistory(content, readHistory, g.id, h, by, shopName, profiles);
    const invoice = content.querySelector("#invoice");
    let qrTurn = 0;
    async function renderInvoice(v) {
      const turn = ++qrTurn;
      registerWatch.stop();
      const requested = v.ina === "0" ? 0n : amount(v.ina);
      if (requested > 10n) throw Error("枚数は1〜10 iineで指定してください。");
      const qrBox = content.querySelector("#qr");
      const qrDisplay = document.createElement("article");
      qrDisplay.id = "qr-out";
      qrBox.replaceChildren(qrDisplay);
      const u = new URL(register(g.id, store.to), location.origin);
      if (requested) u.searchParams.set("ina", String(requested));
      const qr = await QRCode.toDataURL(u.href, {width: 320, margin: 4});
      if (turn !== qrTurn || !qrDisplay.isConnected) return;
      qrDisplay.innerHTML = '<img alt="受け取りQR" src="' + qr + '"><p>' +
        (requested ? requested + ' iine' : 'おまかせ（枚数指定なし）') + '</p>' + link(u.href, "受け取りリンク");
      await registerWatch.start({
        element: qrDisplay, address: store.to, group: g.id,
        onPayment: async rows => {
          recordPayment();
          const ina = rows.filter(row => row.kusa).reduce((sum, row) => sum + row.n, 0n);
          const wara = rows.filter(row => !row.kusa).reduce((sum, row) => sum + row.n, 0n);
          if (ina) crystallize(ina, true);
          else crystallize(wara, true, "wara");
          await readHistory();
          const refreshed = await refresh(true);
          info("着金を確認しました。" + (refreshed ? "" : " 残高と履歴は「更新」で再確認してください。"));
        },
        onError: () => info("着金を照会できません。自動で再試行します。"),
      });
    }
    if (invoice) {
      const updateInvoice = () => {
        for (const chip of invoice.querySelectorAll("[data-invoice]"))
          chip.setAttribute("aria-pressed", String(chip.dataset.invoice === invoice.elements.ina.value));
        void renderInvoice({ina:invoice.elements.ina.value}).catch(error => {
          if (invoice.isConnected) info("QRまたは着金監視を開始できません。「QRを更新」で再試行してください。 " + error.message);
        });
      };
      for (const chip of invoice.querySelectorAll("[data-invoice]")) chip.onclick = () => {
        invoice.elements.ina.value = chip.dataset.invoice;
        invoice.elements.custom.value = chip.dataset.invoice === "0" ? "" : chip.dataset.invoice;
        updateInvoice();
      };
      invoice.elements.custom.onchange = () => {
        if (!invoice.elements.custom.reportValidity()) return;
        invoice.elements.ina.value = invoice.elements.custom.value || "0";
        updateInvoice();
      };
      form("invoice", async () => {
        invoice.elements.ina.value = invoice.elements.custom.value || "0";
        await renderInvoice({ina:invoice.elements.ina.value});
      });
      updateInvoice();
    }
    const inaForm = content.querySelector("#ina");
    if (inaForm) bindMemoChips(inaForm);
    const game = inaForm && bindIineGame(inaForm, {initial:clampCount(n, s.remaining), remaining:s.remaining, member});
    const waraForm = content.querySelector("#wara");
    if (waraForm) bindMemoChips(waraForm);
    form("ina", async (v) => {
      game.unlock();
      const note = paymentMemo(v.memo || "");
      const reaction = paymentReaction(v.reaction || "");
      const n = amount(v.ina);
      if (!member) throw Error("地域に参加してください。");
      if (n > s.remaining) throw Error("残りiineを超えています。");
      if (
        !await confirmDialog({ title: "iineを贈る内容の確認", message:
          store.name +
            "へ " +
            n +
            " iine。相手に " +
            n * 90n +
            " WARA、あなたに " +
            n * 10n +
            " WARA。" + feedbackSummary(reaction,note) + "贈りますか？", confirmLabel: "贈る" })
      ) {
        info("取り消しました。");
        return;
      }
      await send(
        spend(program, who, g.id, store.to, n, s.day, s.nonce, reaction),
        [],
        "贈りました。相手に " +
          n * 90n +
          " WARA、あなたに " +
          n * 10n +
          " WARAが届きました。", note,
      );
      game.success();
    });
    form("wara", async (v) => {
      const note = paymentMemo(v.memo || "");
      const reaction = paymentReaction(v.reaction || "");
      const n = amount(v.amount),
        selected = split(lots, n);
      if (!await confirmDialog({ title: "WARAを贈る内容の確認", message: store.name + "へ\n" + n + " WARA。" + feedbackSummary(reaction,note) + "贈りますか？", confirmLabel: "贈る" })) {
        info("取り消しました。");
        return;
      }
      await send(
        transfer(program, who, g.id, store.to, selected, reaction),
        [],
        n + " WARAを贈りました。", note,
      );
    });
  }
  return store;
}
