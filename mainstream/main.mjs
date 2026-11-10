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
      <h2>🌾 稲を食べて命をつなぎ、藁を編んで暮らす</h2>
      <p>ここでやりとりするのはお金ではなく、<strong>「今日という生きる時間」</strong>と<strong>「誰かの役に立った感謝」</strong>です。</p>
      <dl>
        <dt>🌱 INA（稲） — 毎日の食べる時間</dt>
        <dd>毎朝、だれの財布にも等しく10枚届きます。おむすびを食べたり、日用品を買ったり、日々の食事と暮らしに使えます。<br>
        <strong>今日使わなかったINAは消え、明日また新しいINAが10枚使えます。それはあなたの毎日の時間のようなものなので、貯めることはできません。</strong><br>
        お金持ちでも買い占めることはできません。今日という日を、誰かと温かく分け合って生きるためのものです。</dd>
        <dt>🌾 WARA（藁） — ありがとうの結晶</dt>
        <dd>誰かの役に立ち、喜ばれたあとに残る「感謝の結晶」です。昔の人が藁を編んで草履や蓑を作ったように、人の温もりや仕事が形になって残っていきます。<br>
        <strong>日付が変わっても消えません。</strong><br>
        現時点では、あなたが誰かの力になり、街から受け取った<strong>「感謝の証」</strong>として消えずに残ります。（仲間や公認店舗の間で送り合うこともできます）</dd>
      </dl>
    </section>
    <section><h2>🤝 なぜ「1 INA」で富が生まれるの？</h2>
      <p>あなたがおむすび屋さんに 1 INA 感謝を贈ると、<strong>お店に ＋90 WARA、あなたに ＋10 WARA</strong> が届きます。</p>
      <p>「美味しいご飯を作ってくれてありがとう」「うちのお店に来てくれてありがとう」。感謝が交わされた瞬間、この街に新しい藁（感謝の証）が編み出されるからです。</p>
    </section>
    <section><h2>💡 こんなふうに遊んでみよう（日常のヒント）</h2>
      <p><strong>🏠 1. おうちで「お母さん食堂」</strong><br>
      お母さんが「お母さん食堂」というレジを開きます。息子が夜ご飯を食べたら、「ごちそうさま！」の合図で 1 INA をピッとお支払い。<br>
      お母さんには <strong>＋90 WARA</strong>（料理を作った感謝の結晶）、息子にも <strong>＋10 WARA</strong>（ごちそうさまを言えた証）が貯まります。</p>
      <p><strong>🏫 2. 学校やサークルで「ありがとうの循環」</strong><br>
      「教室の掃除をしてくれてありがとう」「重い荷物を持ってくれてありがとう」。<br>
      普通のお金だと生々しくて渡せないけれど、今日消えてしまう INA だからこそ、照れずに「はい、1 INA！」と贈り合えます。</p>
    </section>
    <section><h2>🛠️ あなたの街・家族で始めるカンタン手順</h2>
      <ol style="padding-left:1.2rem;margin:0">
        <li><strong>コミュニティを作る（<a href="/communities/">🏘️ 画面</a>から）</strong><br>
        「新しいコミュニティを開設」から、名前を決めるだけ（例：「佐藤家」「〇年〇組」「〇〇カフェ仲間」）。</li>
        <li style="margin-top:.5rem"><strong>お店（レジ）を作る</strong><br>
        コミュニティの中で、誰でも自分のお店を持てます。「お母さん食堂」「肩もみ処」「よろず相談」など、あなたの得意な看板を掲げてみましょう。</li>
        <li style="margin-top:.5rem"><strong>スマホ一つでレジを開く</strong><br>
        お財布画面の「レジを開く」からQRを出すだけ。高価なレジ端末も手数料も一切不要です。</li>
      </ol>
    </section>
    <section><h2>👛 お店で支払う</h2>
      <p>お財布画面の「支払う」を押し、お店の会計QRを読み取ります。店名と枚数を確かめて支払いを確定してください。</p>
      <p>手数料（SOL）の心配はいりません。残高ゼロでそのまま使えます。</p>
    </section>
    <section><h2>🏪 お店のレジを開く</h2>
      <p>お財布画面の「レジを開く」で自分の公認店舗を選びます。金額（INA）を入力し、「支払い用QRを表示」を押して、お客さんに読み取ってもらいましょう。</p>
      <p>専用の機械は不要。スマホやタブレットがそのままレジになります。</p>
    </section>
    <section><h2>携帯をお持ちでない方へ</h2>
      <p>スマホを持たないお子さんやお年寄りも、誰ひとり取り残しません。<br>
      電話番号を登録したご家族や店員さんに、<a href="/account/">アカウント</a>で「家族・知人の財布を作る」を開いてもらい、紙のカードを受け取れば、そのカードでお買い物できます。</p>
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
