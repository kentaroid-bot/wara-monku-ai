// No sample balances: signed-out wallets and unavailable reads use a dash.
export function twinCards(state) {
  const remaining = state?.remaining;
  const total = state && [...state.funds.values()].reduce((sum, n) => sum + n, 0n);
  return `<div class="twins">
    <a class="orb kusa ina" href="/shop/"><div class="orb-label">今日の iine</div>
      <div class="orb-value"><strong>${remaining ?? "—"}</strong> / 10 iine</div>
      <div class="dots" aria-hidden="true">${Array.from({length: 10}, (_, i) => `<i class="${i < remaining ? "available" : ""}"></i>`).join("")}</div>
    <div class="orb-cta">👍 相手を選ぶ ›</div></a>
    <a class="orb wara" href="/shop/?mode=receive"><div class="orb-label">WARA</div>
      <div class="orb-value"><strong>${total?.toLocaleString("ja-JP") ?? "—"}</strong> WARA</div>
      <p>ありがとうの結晶</p>
    <div class="orb-cta">🌾 受け取る ›</div></a></div>`;
}

let toastTimeout;
export function crystallize(amount, incoming, currency = "ina") {
  const toast = document.querySelector("#crystal-toast");
  toast.textContent = currency === "wara"
    ? (incoming ? `💖 ありがとう！ あなたに +${amount} WARA が届きました！` : `💖 ありがとう！ 相手に ${amount} WARA を贈りました！`)
    : incoming
    ? `💖 ありがとう！ あなたに +${amount * 100n} WARA 結晶化！`
    : `💖 ありがとう！ 相手に +${amount * 100n} WARA 結晶化！`;
  document.querySelector(".orb.wara")?.animate(
    [{transform: "scale(1)"}, {transform: "scale(1.035)", boxShadow: "0 0 20px #d5bc78"}, {transform: "scale(1)"}],
    {duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 550},
  );
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.textContent = ""; }, 4200);
}
