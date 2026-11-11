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

export function scannerBox(el, kind, accept) {
  const dailyCard = cardKind(kind) === "ina";
  const box = document.createElement("details");
  box.innerHTML =
    "<summary>" +
    (kind === "confirm" ? "大事な手続き用QRを読む" : dailyCard ? "INAカードを読む" : kind === "store" ? "会計QRを読み取る" : "店舗の公開アドレスをQRから読む") +
    '</summary><button type="button">カメラを開く</button><button type="button" class="secondary">停止</button><label>QR画像を選ぶ<input type="file" accept="image/png,image/jpeg,image/webp"></label><video muted autoplay playsinline webkit-playsinline aria-label="QR読み取り用カメラ" style="max-width:100%"></video><canvas hidden></canvas><p role="status">カメラの使用を確認されたら「許可」を選んでください。「QR画像を選ぶ」でも読み取れます。</p>';
  el.append(box);
  const stat = (t) => (box.querySelector("p").textContent = t);
  const reader = createScanner({
    video: box.querySelector("video"),
    canvas: box.querySelector("canvas"),
    onStatus: stat,
    onStop() {},
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
  box.querySelector("button").onclick = () =>
    reader.start(kind).catch((e) => stat(e.message));
  box.querySelectorAll("button")[1].onclick = () => reader.stop();
  box.querySelector("input").onchange = (e) =>
    reader.file(e.target.files[0], kind).catch((x) => stat(x.message));
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
