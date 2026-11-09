import { activate, beginAuth } from "./identity.mjs";

export function signup(el, info) {
  el.innerHTML = `<h1>藁一本の約束をはじめる</h1>
    <p>毎日10枚のKusa。1枚で支払うと、お店に90 WARA、自分に10 WARAが届きます。</p>
    <form id="phoneForm"><h2>電話番号を確認</h2>
    <label>手続き<select name="intent"><option value="activate">新規登録・この端末の財布を引き継ぐ</option><option value="signin">サインイン</option></select></label>
    <p>Devnet試験用です。架空の番号で試せます。確認コードはこの画面に表示します。</p>
    <label>電話番号<input name="phone" type="tel" required placeholder="090-0000-0000"></label>
    <button>確認コードを表示する</button></form><div id="second"></div>`;
  const first = el.querySelector("#phoneForm"),
    second = el.querySelector("#second");
  first.onsubmit = async (e) => {
    e.preventDefault();
    const phone = first.phone.value,
      intent = first.intent.value;
    first.querySelector("button").disabled = true;
    second.replaceChildren();
    try {
      const proof = await beginAuth(phone, intent);
      first.hidden = true;
      info("");
      const mode =
        proof.backend === "worker"
          ? "組み込み・紙カードの財布は暗号化して保存します。同じ番号とパスワードで別の端末から開けます。Phantomの場合は登録したアカウントで署名します。"
          : "この静的サイトでは財布をこのブラウザに保存します。利用・復元にはこの端末が必要です。";
      second.innerHTML = `<form id="walletForm"><p>${mode}</p>
        <p>試験用コード：<b id="otp"></b>（5分間）</p>
        <label>6桁の確認コード<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label>
        <label>ウォレットの方法<select name="type"><option value="embedded">組み込みウォレット</option><option value="phantom">Phantom</option><option value="paper">地域窓口の紙カード</option></select></label>
        <label>ウォレット用パスワード（8文字以上、Phantomでは不要）<input type="password" name="pass" autocomplete="off"></label>
        <button>お財布を開く</button> <button type="button" class="secondary">番号・手続きの変更／コード再発行</button></form>`;
      second.querySelector("#otp").textContent =
        proof.trialCode ?? proof.local.code;
      const form = second.querySelector("form"),
        reset = form.querySelector('[type="button"]');
      reset.onclick = () => {
        second.replaceChildren();
        first.hidden = false;
        info("");
      };
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const button = form.querySelector("button");
        button.disabled = reset.disabled = true;
        try {
          await activate(
            phone,
            form.type.value,
            form.pass.value,
            proof,
            form.otp.value,
          );
          location.assign("/");
        } catch (err) {
          info(err.message);
        } finally {
          button.disabled = reset.disabled = false;
        }
      };
    } catch (err) {
      info(err.message);
    } finally {
      first.querySelector("button").disabled = false;
    }
  };
}
