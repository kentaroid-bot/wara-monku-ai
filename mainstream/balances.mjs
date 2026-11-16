// No sample balances: signed-out wallets and unavailable reads use a dash.
export function twinCards(state, signedIn = Boolean(state)) {
  const remaining = state?.remaining;
  const total = state && [...state.funds.values()].reduce((sum, n) => sum + n, 0n);
  return `<div id="home-stage" class="home-stage">
    <div class="top-counters"><span aria-label="残りiine"><strong>${remaining ?? "—"}</strong> ♥</span>
      <a href="#origins" aria-label="保有WARAと発行元"><strong>${total?.toLocaleString("ja-JP") ?? "—"}</strong> 🌾</a></div>
    <a class="home-send" href="/shop/" aria-label="相手を選ぶ" data-empty="${remaining === 0n || remaining === 0}">
      <span class="home-send-label" aria-hidden="true">おくる</span><img class="home-heart" src="/v3/ehon/heart.webp" alt=""><img class="home-sender" src="/v3/ehon/sender.webp" alt=""><span class="visually-hidden">相手を選ぶ</span></a>
    <div class="home-send-fx" aria-hidden="true">${Array.from({length:12},(_,i)=>`<span>${i%3 ? "✦" : "♥"}</span>`).join("")}</div>
    <div class="home-history">${signedIn ? "" : '<a class="action home-signin" href="/signup/">登録・サインイン</a>'}</div>
    <a class="home-receive" href="/shop/?mode=receive" aria-label="受け取る"><img src="/v3/ehon/receiver.webp" alt=""><span class="home-receive-label" aria-hidden="true">うけとる</span></a>
  </div>`;
}

let toastTimeout;
export function crystallize(amount, incoming, currency = "ina") {
  const toast = document.querySelector("#crystal-toast");
  toast.textContent = currency === "wara"
    ? (incoming ? `💖 ありがとう！ あなたに +${amount} WARA が届きました！` : `💖 ありがとう！ 相手に ${amount} WARA を贈りました！`)
    : incoming
    ? `💖 ありがとう！ あなたに +${amount * 100n} WARA 結晶化！`
    : `💖 ありがとう！ 相手に +${amount * 100n} WARA 結晶化！`;
  document.querySelector(".top-counters")?.animate(
    [{transform: "scale(1)"}, {transform: "scale(1.035)", boxShadow: "0 0 20px #d5bc78"}, {transform: "scale(1)"}],
    {duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 550},
  );
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.textContent = ""; }, 4200);
}
