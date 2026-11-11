import { thankYouChips } from "../shared/payment-memo.mjs";

export const memoFields = `<fieldset class="payment-memo"><legend>感謝のメッセージ（任意）</legend>
  <div class="memo-chips">${thankYouChips.map(text=>`<button type="button" class="secondary" data-memo-chip>${text}</button>`).join("")}</div>
  <label>一言メッセージ<input name="memo" autocomplete="off" placeholder="自分の言葉でひとこと"></label>
  <small>60文字まで。メッセージは公開台帳に残ります。</small></fieldset>`;

export function bindMemoChips(form) {
  for (const button of form.querySelectorAll("[data-memo-chip]")) {
    button.onclick = () => { form.elements.memo.value = button.textContent; form.elements.memo.focus(); };
  }
}
