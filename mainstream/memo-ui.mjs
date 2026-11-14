import { reactions, thankYouChips } from "../shared/payment-memo.mjs";

export function memoFields(privateNotes) {
  return `<details class="payment-memo"><summary>ありがとうを添える（任意）</summary>
    <fieldset><legend>気持ちをひとつ</legend><div class="memo-chips">
    ${reactions.map(emoji => `<button type="button" class="secondary" aria-pressed="false" data-reaction="${emoji}">${emoji}</button>`).join("")}</div>
    <input type="hidden" name="reaction" value=""><small>選んだ絵文字は公開台帳に残ります。</small></fieldset>
    ${privateNotes ? `<label>お店へのひとこと<input name="memo" autocomplete="off" placeholder="自分の言葉でひとこと"></label>
    <div class="memo-chips">${thankYouChips.map(text => `<button type="button" class="secondary" data-memo-chip>${text}</button>`).join("")}</div>
    <small>60文字まで。文章はお店にだけ届きます。</small>` : ""}</details>`;
}

export function bindMemoChips(form) {
  const buttons = form.querySelectorAll("[data-reaction]");
  for (const button of buttons) button.onclick = () => {
    const field = form.elements.reaction;
    field.value = field.value === button.dataset.reaction ? "" : button.dataset.reaction;
    for (const choice of buttons) choice.setAttribute("aria-pressed", String(choice.dataset.reaction === field.value));
  };
  for (const button of form.querySelectorAll("[data-memo-chip]"))
    button.onclick = () => { form.elements.memo.value = button.textContent; form.elements.memo.focus(); };
}
