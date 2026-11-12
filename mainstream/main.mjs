import { themeKey, accessVersionKey, afterInviteKey, afterSigninKey, introducedKey, warmthKey } from "./storage-keys.mjs";
import { showGuide } from "./views/guide.mjs";
import { parseInvitation, pendingInvite } from "./community-privacy.mjs";
import { Buffer } from "buffer";
import { twinCards } from "./balances.mjs";
import { paymentHistory } from "./history.mjs";
import QRCode from "qrcode";
import { active, signout, unlock, memberSessionKey, managedSession, restorePhantom, authMode } from "./identity.mjs";
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
const pathname = location.pathname.replace(/\/+$/, "") || "/";
const path = pathname === "/register" ? "/shop" : pathname;
const tab = path === "/support" ? "guide" :
  ["/", "/user"].includes(path) ? "wallet" :
  (path === "/shop" || path.startsWith("/communities")) ? "market" : "me";
document.querySelector(`[data-tab="${tab}"]`).setAttribute("aria-current", "page");
const theme = localStorage.getItem(themeKey);
if (theme === "dark" || theme === "light") document.documentElement.style.colorScheme = theme;
document.querySelector(".theme").onclick = () => {
  const current = document.documentElement.style.colorScheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.style.colorScheme = next;
  localStorage.setItem(themeKey, next);
};
const cooldown = 15 * 60_000;
let lastPayment = 0;
let coolingTimer;

function paintWarmth() {
  clearTimeout(coolingTimer);
  const age = Date.now() - lastPayment;
  const warmth = lastPayment > 0 && age >= 0 ? Math.max(0, Math.min(1, (cooldown - age) / (cooldown - 60_000))) : 0;
  document.documentElement.style.setProperty("--warmth", String(warmth));
  if (warmth && !document.hidden) coolingTimer = setTimeout(paintWarmth, 1000);
}

function restoreWarmth() {
  try { lastPayment = Number(localStorage.getItem(warmthKey)); } catch { /* Use this page's state. */ }
  paintWarmth();
}

function recordPayment(at = Date.now()) {
  const now = Date.now();
  if (!Number.isFinite(at) || at <= now - cooldown || at > now || (lastPayment <= now && at <= lastPayment)) return;
  lastPayment = at;
  try { localStorage.setItem(warmthKey, String(at)); } catch { /* Feedback also works without storage. */ }
  paintWarmth();
}

restoreWarmth();
window.addEventListener("pageshow", restoreWarmth);
document.addEventListener("visibilitychange", paintWarmth);
window.addEventListener("storage", event => {
  if (event.key === warmthKey || event.key === null) restoreWarmth();
});

let profile = active();
let signer = null;
window.addEventListener("pagehide", () => {
  signer = null;
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted && (path === "/signup" || active()?.address !== profile?.address)) location.reload();
});
window.addEventListener("storage", (event) => {
  if (event.storageArea !== localStorage || (event.key !== memberSessionKey && event.key !== null)) return;
  signer = null;
  if (profile?.managed && !managedSession()) location.replace("/signup/");
  else location.reload();
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
  '<section class="welcome"><small>はじめての方へ</small><h2>今日の時間を、地域の力に。</h2><p>毎日届く10 INAで食事や仕事に感謝を贈れます。受け取ったWARAは、明日も財布に残ります。</p><a class="action" href="/signup/">登録・サインイン</a></section>';
async function card() {
  const box = el.querySelector(".card");
  if (!box) return;
  box.querySelector("img").src = await QRCode.toDataURL(
    "wara:v3:" + profile.address,
    { width: 220 },
  );
  box.querySelector("button").onclick = () => print();
}
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#/join?")) location.reload();
});
async function render() {
  const invitation = parseInvitation(location.hash);
  if (invitation) {
    sessionStorage.setItem(pendingInvite(invitation.group), invitation.code);
    location.replace("/communities/?id=" + invitation.group);
    return;
  }
  if (!profile?.managed && path !== "/support") {
    try { await restorePhantom(); } catch { /* Keep the normal sign-in available offline. */ }
    profile = active();
  }
  const readHistory = profile && paymentHistory(profile.address, recordPayment);
  if (readHistory) {
    const checkReceipts = () => {
      if (document.hidden) return;
      const panel = el.querySelector("[data-payment-history]");
      if (panel) panel.dispatchEvent(new Event("refresh-history"));
      else void readHistory().catch(() => {});
    };
    // Wallet and shop history panels fetch on mount.
    if (!["/", "/user", "/shop", "/communities"].includes(path)) checkReceipts();
    setInterval(checkReceipts, 60_000);
    document.addEventListener("visibilitychange", checkReceipts);
  }
  if (path === "/support") {
    showGuide(el);
    return;
  }
  if (path === "/signup" && profile?.managed && profile.type === "phantom") { location.replace("/account/"); return; }
  if(profile?.managed) {
    const expires=managedSession()?.expires || Date.now();
    setTimeout(()=>{if(!managedSession()){signout();location.replace("/signup/");}},Math.max(0,expires-Date.now())+30);
  } else if(profile && path!=="/signup" && await authMode()!=="local" && sessionStorage.getItem(accessVersionKey)==="3") {
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
  el.innerHTML = "<h1>" + esc(titles[path] || "WARA") + "</h1>";
  if (!profile) {
    if (tab === "wallet") el.insertAdjacentHTML("beforeend", twinCards(null));
    const group = new URLSearchParams(location.search).get("id");
    if (path === "/communities" && group && sessionStorage.getItem(pendingInvite(group)))
      sessionStorage.setItem(afterInviteKey, group);
    if (path === "/shop" && location.search)
      sessionStorage.setItem(
        afterSigninKey,
        "/shop/" + location.search,
      );
    el.insertAdjacentHTML("beforeend", welcome);
    return;
  }
  const invitedGroup = sessionStorage.getItem(afterInviteKey);
  if (invitedGroup && (path === "/" || path === "/account")) {
    sessionStorage.removeItem(afterInviteKey);
    location.replace("/communities/?id=" + encodeURIComponent(invitedGroup));
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
        '</p><p>手数料支援が有効な場合、参加・INA払い・WARA払いにSOLは不要です。自費の取引にはテストSOLを使います。<a href="https://faucet.solana.com/" target="_blank" rel="noopener">Devnetの無料配布</a></p><button id="exit">サインアウト</button></section><article class="card"><h2>INAカード</h2><img alt="このウォレットの公開QR"><p class="wrap">' +
        esc(profile.address) +
        "</p><small>QRだけでお財布から引き落とすことはできません。</small><br><button>印刷する</button></article>",
    );
    el.querySelector("#exit").onclick = () => {
      signer = null;
      signout();
      location.replace("/signup/");
    };
    if(profile.managed) {
      if(sessionStorage.getItem(introducedKey)) { sessionStorage.removeItem(introducedKey); info("ご本人の財布を作りました。紙を本人に渡してください。今の画面は紹介者の財布です。"); }
      el.querySelector(".card h2").textContent="公開アドレス";
      (await import("./member-ui.mjs")).accountTools(el,info,await authMode());
    }
    el.insertAdjacentHTML("beforeend", '<details><summary>毎日のINAのリセット</summary><p>日本時間の24:00に、その日の残りが消え、新しい10 INAが使えるようになります。WARAは残ります。</p><a class="action secondary" href="/">今日の枠を読み直す</a></details>');
    await card();
    return;
  }
  if (path === "/") {
    const after = sessionStorage.getItem(afterSigninKey);
    if (after) {
      sessionStorage.removeItem(afterSigninKey);
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
  await dashboard({ el, info, path, profile, wallet, action, esc, recordPayment, readHistory });
}
render().catch((e) => info(e.message));
