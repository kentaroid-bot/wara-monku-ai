import { Buffer } from "buffer";
import QRCode from "qrcode";
import { active, signout, unlock } from "./identity.mjs";
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
const path = location.pathname.replace(/\/+$/, "") || "/",
  profile = active();
let signer = null;
window.addEventListener("pagehide", () => {
  signer = null;
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted && active()?.address !== profile?.address) location.reload();
});
export async function wallet() {
  if (!profile || active()?.address !== profile.address)
    throw Error("アカウントが切り替わりました。再度サインインしてください。");
  if (profile.type === "phantom") return unlock(profile, "");
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
  '<section><h2>あなたのお財布</h2><p>毎日10 Kusa。今日使わなかった枠は翌日に持ち越せません。受け取ったWARAは翌日も使えます。</p><a class="action" href="/signup/">登録・サインイン</a></section>';
async function card() {
  const box = el.querySelector(".card");
  if (!box) return;
  box.querySelector("img").src = await QRCode.toDataURL(
    "wara:v3:" + profile.address,
    { width: 220 },
  );
  box.querySelector("button").onclick = () => print();
}
async function render() {
  if (path === "/signup") {
    signup(el, info);
    return;
  }
  const titles = {
    "/": "お財布",
    "/user": "お財布",
    "/shop": "レジ",
    "/account": "アカウント",
    "/support": "地域窓口",
    "/communities": "コミュニティ",
    "/communities/new": "コミュニティを開設",
  };
  el.innerHTML = "<h1>" + esc(titles[path] || "藁一本の約束") + "</h1>";
  if (!profile) {
    if (path === "/shop" && location.search)
      sessionStorage.setItem(
        "wara.v03.after-signin",
        location.pathname + location.search,
      );
    el.insertAdjacentHTML(
      "beforeend",
      path === "/support"
        ? "<p>紙カードを発行する方は、登録方法で「地域窓口」を選んでください。</p>" +
            welcome
        : welcome,
    );
    return;
  }
  if (path === "/account" || path === "/support") {
    el.insertAdjacentHTML(
      "beforeend",
      "<section><h2>" +
        {
          phantom: "Phantom",
          paper: "窓口発行",
          embedded: "組み込みウォレット",
        }[profile.type] +
        '</h2><p class="wrap">' +
        esc(profile.address) +
        '</p><p>新しいウォレットにDevnet SOLがない場合、取引手数料にテストSOLが必要です。<a href="https://faucet.solana.com/" target="_blank" rel="noopener">Devnetの無料配布</a></p><button id="exit">サインアウト</button></section><article class="card"><h2>Kusaカード</h2><img alt="このウォレットの公開QR"><p class="wrap">' +
        esc(profile.address) +
        "</p><small>QRだけでお財布から引き落とすことはできません。</small><br><button>印刷する</button></article>",
    );
    el.querySelector("#exit").onclick = () => {
      signer = null;
      signout();
      location.assign("/");
    };
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
