import { createScanner } from "../app/qr-media.mjs";
import { pk } from "./protocol.mjs";

export function invoiceAmount(params) {
  const value = params.get("ina") || params.get("kusa");
  return /^([1-9]|10)$/.test(value) ? value : null;
}

export function storeInvoiceUrl(value, origin) {
  const u = new URL(value);
  if (u.origin !== origin || !["/shop", "/shop/", "/register", "/register/"].includes(u.pathname))
    throw Error("このサイトのお会計QRを選んでください。");
  const clean = new URL("/shop/", origin);
  for (const key of ["group", "store"])
    clean.searchParams.set(key, String(pk(u.searchParams.get(key))));
  const amount = invoiceAmount(u.searchParams);
  if (amount) clean.searchParams.set("ina", amount);
  return clean.href;
}

function cardKind(kind) {
  return kind === "kusa" ? "ina" : kind;
}

export function paperCardCode(value, kind) {
  const match = /^wara:(ina|kusa|confirm):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(value);
  if (match && cardKind(match[1]) === cardKind(kind)) return match[2];
  throw Error("用途の合う紙のQRを読み取ってください。");
}

export function isInAppBrowser(userAgent, phantom = false) {
  // A desktop Phantom extension must not disable the normal browser camera.
  return /Phantom|; wv\)|FBAN|FBAV|Instagram|Line\//i.test(userAgent) ||
    (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) && phantom);
}

export function scannerBox(el, kind, accept) {
  const dailyCard = cardKind(kind) === "ina";
  const inAppBrowser = isInAppBrowser(navigator.userAgent, !!(window.phantom?.solana?.isPhantom || window.solana?.isPhantom));
  const imageGuidance = "「カメラ・写真でQRを読む」でも読み取れます。";
  const initialGuidance = "ボタンを押して、カメラ撮影または写真からQRコードを読み取ってください。";
  const box = document.createElement("details");
  box.innerHTML =
    "<summary>" +
    (kind === "confirm" ? "大事な手続き用QRを読む" : dailyCard ? "INAカードを読む" : kind === "store" ? "会計QRを読み取る" : "店舗の公開アドレスをQRから読む") +
    '</summary><label class="button file-picker">カメラ・写真でQRを読む<input type="file" accept="image/*"></label>' +
    (inAppBrowser ? '' : '<button type="button" class="button secondary">カメラを開く</button><button type="button" class="button secondary">停止</button>') +
    '<video hidden muted autoplay playsinline webkit-playsinline aria-label="QR読み取り用カメラ" style="max-width:100%"></video><canvas hidden></canvas><p role="status">' +
    initialGuidance + (inAppBrowser ? '' : 'カメラを開く場合、使用を確認されたら「許可」を選んでください。') + '</p>';
  el.append(box);
  const stat = (t) => (box.querySelector("p").textContent = t);
  const video = box.querySelector("video");
  const reader = createScanner({
    imageGuidance,
    video,
    canvas: box.querySelector("canvas"),
    onStatus: stat,
    onStop() { video.hidden = true; },
    async onValue(value) {
      if (kind === "store") {
        await accept(storeInvoiceUrl(value, location.origin));
      } else if (kind === "confirm" || dailyCard) {
        await accept(paperCardCode(value, kind));
      } else {
        await accept(String(pk(value.replace(/^wara:v3:/, ""))));
        stat("受取アドレスを読み取りました。");
      }
    },
  });
  if (!inAppBrowser) {
    box.querySelector("button").onclick = async () => {
      try {
        await reader.start(kind);
        video.hidden = !video.srcObject;
      } catch (e) { stat(e.message); }
    };
    box.querySelectorAll("button")[1].onclick = () => reader.stop();
  }
  for (const input of box.querySelectorAll('input[type="file"]')) {
    // Reset only when opening the picker; keep the selected File alive while decoding.
    input.onclick = (e) => { e.currentTarget.value = ""; };
    input.onchange = (e) => {
      const file = e.currentTarget.files[0];
      if (!file) return;
      stat("QRコードを解析しています…");
      reader.file(file, kind).catch((x) => stat(x.message));
    };
  }
  box.ontoggle = () => {
    if (!box.open) reader.stop();
  };
  const stop = () => reader.stop();
  window.addEventListener("pagehide", stop, { once: true });
  const observer = new MutationObserver(() => {
    if (!box.isConnected) {
      stop();
      observer.disconnect();
      window.removeEventListener("pagehide", stop);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
