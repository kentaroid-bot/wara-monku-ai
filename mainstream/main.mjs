import { Buffer } from "buffer";
import { twinCards } from "./balances.mjs";
import QRCode from "qrcode";
import { active, signout, unlock, managedSession, restorePhantom, authMode } from "./identity.mjs";
import { signup } from "./signup.mjs";
globalThis.Buffer ??= Buffer;
export const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const el = document.querySelector("#screen"),
  notice = document.querySelector("#notice");
const info = (s) => {
  notice.textContent = s;
};
const path = location.pathname.replace(/\/+$/, "") || "/";
const tab = path === "/support" ? "guide" :
  ["/", "/user"].includes(path) ? "wallet" :
  (path === "/shop" || path.startsWith("/communities")) ? "market" : "me";
document.querySelector(`[data-tab="${tab}"]`).setAttribute("aria-current", "page");
const theme = localStorage.getItem("wara.theme");
if (theme === "dark" || theme === "light") document.documentElement.style.colorScheme = theme;
document.querySelector(".theme").onclick = () => {
  const current = document.documentElement.style.colorScheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.style.colorScheme = next;
  localStorage.setItem("wara.theme", next);
};
let profile = active();
let signer = null;
window.addEventListener("pagehide", () => {
  signer = null;
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted && (path === "/signup" || active()?.address !== profile?.address)) location.reload();
});
export async function wallet() {
  if (!profile || active()?.address !== profile.address)
    throw Error("アカウントが切り替わりました。再度サインインしてください。");
  if (profile.type === "phantom") return unlock(profile, "");
  if(profile.managed) return (await import("./member-ui.mjs")).siteSigner(profile);
  if (!signer) {
    const pass = prompt("この端末のウォレット用パスワード");
    if (pass === null) throw Error("署名を取り消しました。");
    signer = await unlock(profile, pass);
  }
  return signer;
}
export function action(form, handler) {
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = "1";
    const btn = form.querySelector("button[type=submit],button:not([type])");
    if (btn) btn.disabled = true;
    try {
      info("処理中…");
      await handler(Object.fromEntries(new FormData(form)), form);
    } catch (x) {
      info(x.message);
    } finally {
      delete form.dataset.busy;
      if (btn) btn.disabled = false;
    }
  };
}
const welcome =
  '<section class="welcome"><small>はじめての方へ</small><h2>今日の時間を、地域の力に。</h2><p>毎日届く10 kusaで食事や仕事に感謝を贈れます。受け取ったWARAは、明日も財布に残ります。</p><a class="action" href="/signup/">登録・サインイン</a></section>';
async function card() {
  const box = el.querySelector(".card");
  if (!box) return;
  box.querySelector("img").src = await QRCode.toDataURL(
    "wara:v3:" + profile.address,
    { width: 220 },
  );
  box.querySelector("button").onclick = () => print();
}
function showGuide() {
  el.innerHTML = `<h1>使い方</h1>
    <section class="guide-intro">
      <h2>藁一本の約束とは</h2>
      <dl>
        <dt>🌱 kusa（草）</dt>
        <dd>今日の24時間を生きるための10枚です。食事や日々のお礼に使えます。日本時間の午前0時に残りは消え、新しい10枚が使えるようになります。</dd>
        <dt>✨ WARA（藁）</dt>
        <dd>役に立った仕事へ贈られた、感謝の結晶です。日付が変わっても財布に残り、貯めて道具や設備、大きな仕事の支払いに使えます。</dd>
      </dl>
    </section>
    <section><h2>お店で支払う</h2>
      <p>お財布の「支払う」から、お店の会計QRを読み取ります。店名と枚数を確かめて支払いを確定してください。</p>
      <p>1 kusaで支払うと、お店に90 WARA、あなたに10 WARAが届きます。</p>
    </section>
    <section><h2>お店のレジを開く</h2>
      <p>お財布の「レジを開く」で自分の公認店舗を選びます。金額をkusaで入力し、「支払い用QRを表示」を押して、お客さんに読み取ってもらいましょう。</p>
    </section>
    <section><h2>携帯をお持ちでない方へ</h2>
      <p>電話番号を登録したご家族や店員さんに、<a href="/account/">アカウント</a>で「家族・知人の財布を作る」を開いてもらいます。氏名・質問の答え・暗証番号はご本人が入力し、印刷した紙カードを受け取ってください。</p>
    </section>`;
}
async function render() {
  if (path === "/support") {
    showGuide();
    return;
  }
  if (!profile?.managed) {
    try { await restorePhantom(); } catch { /* Keep the normal sign-in available offline. */ }
    profile = active();
  }
  if (path === "/signup" && profile?.managed && profile.type === "phantom") { location.replace("/account/"); return; }
  if(profile?.managed) {
    const expires=managedSession()?.expires || Date.now();
    setTimeout(()=>{if(!managedSession()){signout();location.replace("/signup/");}},Math.max(0,expires-Date.now())+30);
  } else if(profile && path!=="/signup" && await authMode()!=="local" && sessionStorage.getItem("wara.access.version")==="3") {
    signout();location.replace("/signup/");return;
  }
  if (path === "/signup") {
    signup(el, info);
    return;
  }
  const titles = {
    "/": "お財布",
    "/user": "お財布",
    "/shop": "レジ",
    "/account": "アカウント",
    "/communities": "市場",
    "/communities/new": "コミュニティを開設",
  };
  el.innerHTML = "<h1>" + esc(titles[path] || "藁一本の約束") + "</h1>";
  if (!profile) {
    if (tab === "wallet") el.insertAdjacentHTML("beforeend", twinCards(null));
    if (path === "/shop" && location.search)
      sessionStorage.setItem(
        "wara.v03.after-signin",
        location.pathname + location.search,
      );
    el.insertAdjacentHTML("beforeend", welcome);
    return;
  }
  if (path === "/account") {
    el.insertAdjacentHTML(
      "beforeend",
      "<section><h2>" +
        {
          phantom: "Phantom",
          paper: "窓口発行",
          embedded: "組み込みウォレット",
        }[profile.type] +
        '</h2><small>公開アドレス</small><p class="wrap">' +
        esc(profile.address) +
        '</p><p>手数料支援が有効な場合、参加・kusa払い・WARA払いにSOLは不要です。自費の取引にはテストSOLを使います。<a href="https://faucet.solana.com/" target="_blank" rel="noopener">Devnetの無料配布</a></p><button id="exit">サインアウト</button></section><article class="card"><h2>Kusaカード</h2><img alt="このウォレットの公開QR"><p class="wrap">' +
        esc(profile.address) +
        "</p><small>QRだけでお財布から引き落とすことはできません。</small><br><button>印刷する</button></article>",
    );
    el.querySelector("#exit").onclick = () => {
      signer = null;
      signout();
      location.assign("/");
    };
    if(profile.managed) {
      if(sessionStorage.getItem("wara.introduced")) { sessionStorage.removeItem("wara.introduced"); info("ご本人の財布を作りました。紙を本人に渡してください。今の画面は紹介者の財布です。"); }
      el.querySelector(".card h2").textContent="公開アドレス";
      (await import("./member-ui.mjs")).accountTools(el,info,await authMode());
    }
    el.insertAdjacentHTML("beforeend", '<details><summary>毎日のkusaのリセット</summary><p>日本時間の24:00に、その日の残りが消え、新しい10 kusaが使えるようになります。WARAは残ります。</p><a class="action secondary" href="/">今日の枠を読み直す</a></details>');
    await card();
    return;
  }
  if (path === "/") {
    const after = sessionStorage.getItem("wara.v03.after-signin");
    if (after) {
      sessionStorage.removeItem("wara.v03.after-signin");
      if (after.startsWith("/shop/?") || after.startsWith("/shop?"))
        el.insertAdjacentHTML(
          "beforeend",
          '<p><a class="action" href="' +
            esc(after) +
            '">読み取ったお会計に戻る</a></p>',
        );
    }
  }
  const { dashboard } = await import("./screens.mjs");
  await dashboard({ el, info, path, profile, wallet, action, esc });
}
render().catch((e) => info(e.message));
