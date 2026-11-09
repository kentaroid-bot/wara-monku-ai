import { activate, authMode, beginAuth, hasDeviceWallet, normalizePhone, resolveWallet } from "./identity.mjs";

const titles = {
  signin: "サインイン",
  create: "新しく財布を作る",
  transfer: "この端末の財布を引き継ぐ",
};

export async function signup(el, info) {
  let delivery;
  try {
    delivery = await authMode();
  } catch (error) {
    info(error.message);
    el.textContent = "再読み込みしてお試しください。";
    return;
  }
  if(delivery!=="local" && sessionStorage.getItem("wara.access.version")==="3"){
    const {memberSignup}=await import("./member-ui.mjs");
    return memberSignup(el,info,delivery);
  }
  const sms = delivery === "google" || delivery === "sms";
  const transferAvailable = delivery !== "local" && hasDeviceWallet();

  function submit(handler) {
    const form = el.querySelector("form");
    form.onsubmit = async (event) => {
      event.preventDefault();
      const fieldset = form.querySelector("fieldset");
      if (fieldset.disabled) return;
      fieldset.disabled = true;
      info("");
      try {
        await handler(form);
      } catch (error) {
        info(error.message);
      } finally {
        fieldset.disabled = false;
      }
    };
  }

  function entry() {
    info("");
    el.innerHTML = `<h1>登録・サインイン</h1><section>
      <button data-intent="signin">サインイン</button>
      <button class="secondary" data-intent="create">新しく財布を作る</button>
      ${transferAvailable ? '<button class="secondary" data-intent="transfer">この端末の財布を引き継ぐ</button>' : ""}
      </section>`;
    for (const button of el.querySelectorAll("[data-intent]"))
      button.onclick = () => phoneStep(button.dataset.intent);
  }

  const back = '<button type="button" class="secondary" data-back>手続きを選び直す</button>';
  function screen(title, body) {
    el.innerHTML = `<h1>${title}</h1><form><fieldset>${body}${back}</fieldset></form>`;
    el.querySelector("[data-back]").onclick = entry;
    info("");
  }
  function phoneStep(intent) {
    const notice = delivery === "google"
      ? "番号の確認と不正利用防止のため、Googleが電話番号を受け取り、保存します。同意のうえSMSを受け取ってください。"
      : sms ? "入力した携帯番号に確認コードをSMSで送ります。" : "試験用の確認コードをこの画面に表示します。";
    screen(titles[intent], `<p>${notice}</p>
      <label>電話番号（ハイフンは任意）<input type="tel" name="phone" autocomplete="tel" required></label>
      <div id="phoneCaptcha"></div><button>${sms ? "SMSで確認コードを受け取る" : "確認コードを表示する"}</button>`);
    submit(async (form) => {
      const phone = normalizePhone(form.elements.phone.value);
      const proof = await beginAuth(phone, intent === "signin" ? "signin" : "activate", delivery);
      if (delivery === "google") {
        const { sendPhoneCode } = await import("/v3/google-phone.js");
        proof.confirmPhone = await sendPhoneCode(proof.firebase, phone, form.querySelector("#phoneCaptcha"));
      }
      codeStep(intent, phone, proof);
    });
  }
  function codeStep(intent, phone, proof) {
    screen("電話番号を確認", `<p>${sms ? "SMSに届いた6桁のコードを入力してください。" : "試験用コード：" + (proof.trialCode ?? proof.local.code)}</p>
      <label>6桁の確認コード<input name="otp" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label>
      <button>次へ</button><button type="button" class="secondary" data-resend>コードを再発行</button>`);
    el.querySelector("[data-resend]").onclick = () => phoneStep(intent);
    el.querySelector("[name=otp]").focus();
    submit(async (form) => {
      const step = await resolveWallet(phone, proof, form.elements.otp.value);
      if (step.action === "signin") {
        walletStep(phone, step, step.type, intent === "signin" ? "" : "この番号には登録済みの財布があります。");
        if (intent === "signin" && step.type === "phantom") el.querySelector("form").requestSubmit();
      } else if (step.deviceWallet) {
        transferStep(phone, step);
      } else if (intent === "create") {
        walletStep(phone, step, null);
      } else {
        screen(titles[intent], `<p>${intent === "transfer" ? "この番号で引き継げる財布が端末に見つかりません。" : "この番号にはまだ財布がありません。"}</p><button>新しく財布を作る</button>`);
        submit(() => walletStep(phone, step, null));
      }
    });
  }
  function transferStep(phone, step) {
    step.transfer = true;
    walletStep(phone, step, step.deviceWallet.type, "この端末の財布を電話番号に紐付けます。");
    el.querySelector("[data-address]").textContent = step.deviceWallet.address;
  }
  function walletStep(phone, step, knownType, note = "") {
    const signingIn = step.action === "signin";
    screen(signingIn ? titles.signin : step.transfer ? titles.transfer : titles.create, `
      ${note ? `<p>${note}</p>` : ""}
      ${step.transfer ? '<p class="wrap" data-address></p>' : ""}
      ${knownType ? "" : '<label>ウォレットの方法<select name="method"><option value="embedded">組み込みウォレット</option><option value="phantom">Phantom</option><option value="paper">地域の紙カード</option></select></label>'}
      <label data-password>ウォレット用パスワード（8文字以上）<input name="pass" type="password" minlength="8" autocomplete="${!knownType ? "new-password" : "current-password"}"></label>
      <button type="submit"></button>`);
    const form = el.querySelector("form");
    const method = () => knownType ?? form.elements.method.value;
    const update = () => {
      const phantom = method() === "phantom";
      form.querySelector("[data-password]").hidden = phantom;
      form.elements.pass.disabled = phantom;
      form.elements.pass.required = !phantom;
      form.querySelector("[type=submit]").textContent = phantom
        ? (signingIn ? "登録済みのPhantomで署名する" : "Phantomで署名する")
        : (signingIn ? "財布を開く" : step.transfer ? "この財布を紐付ける" : "財布を作る");
    };
    if (!knownType) form.elements.method.onchange = update;
    update();
    submit(async () => {
      await activate(phone, method(), form.elements.pass.value, step);
      location.assign("/");
    });
  }
  entry();
}
