import { createScanner } from "../app/qr-media.mjs";
import { pk } from "./protocol.mjs";
export function scannerBox(el, kind, accept) {
  const box = document.createElement("details");
  box.innerHTML =
    "<summary>" +
    (kind === "store" ? "会計QRを読み取る" : "店舗の公開アドレスをQRから読む") +
    '</summary><button type="button">カメラを開く</button><button type="button" class="secondary">停止</button><label>QR画像を選ぶ<input type="file" accept="image/png,image/jpeg,image/webp"></label><video muted playsinline style="max-width:100%"></video><canvas hidden></canvas><p role="status"></p>';
  el.append(box);
  const stat = (t) => (box.querySelector("p").textContent = t);
  const reader = createScanner({
    video: box.querySelector("video"),
    canvas: box.querySelector("canvas"),
    onStatus: stat,
    onStop() {},
    onValue(value) {
      if (kind === "store") {
        const u = new URL(value);
        if (
          u.origin !== location.origin ||
          !["/shop", "/shop/"].includes(u.pathname)
        )
          throw Error("このサイトのお会計QRを選んでください。");
        const clean = new URL("/shop/", location.origin);
        for (const k of ["group", "store"])
          clean.searchParams.set(k, String(pk(u.searchParams.get(k))));
        if (/^([1-9]|10)$/.test(u.searchParams.get("kusa")))
          clean.searchParams.set("kusa", u.searchParams.get("kusa"));
        accept(clean.href);
      } else {
        accept(String(pk(value.replace(/^wara:v3:/, ""))));
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
  observer.observe(el.parentElement ?? el, { childList: true, subtree: true });
}
