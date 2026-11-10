// No sample balances: signed-out wallets and unavailable reads use a dash.
export function twinCards(state) {
  const remaining = state?.remaining;
  const total = state && [...state.funds.values()].reduce((sum, n) => sum + n, 0n);
  return `<div class="twins">
    <section class="orb kusa"><div class="orb-label">今日の時間 <span>24:00消滅</span></div>
      <div class="orb-value"><strong>${remaining ?? "—"}</strong> / 10 kusa</div>
      <div class="dots" aria-hidden="true">${Array.from({length: 10}, (_, i) => `<i class="${i < remaining ? "available" : ""}"></i>`).join("")}</div>
    </section>
    <section class="orb wara"><div class="orb-label">感謝の蓄積 <span>永続</span></div>
      <div class="orb-value"><strong>${total?.toLocaleString("ja-JP") ?? "—"}</strong> WARA</div>
      <p>あなたの仕事が誰かの生活を支えた結晶</p>
    </section></div>`;
}

let toastTimeout;
export function crystallize(amount, incoming) {
  const toast = document.querySelector("#crystal-toast");
  toast.textContent = incoming
    ? `✨ あなたの店に +${amount * 90n} / お客さんに +${amount * 10n} WARA 結晶化！`
    : `✨ 店に +${amount * 90n} / あなたに +${amount * 10n} WARA 結晶化！`;
  document.querySelector(".orb.wara")?.animate(
    [{transform: "scale(1)"}, {transform: "scale(1.035)", boxShadow: "0 0 20px #d5bc78"}, {transform: "scale(1)"}],
    {duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 550},
  );
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.textContent = ""; }, 4200);
}
