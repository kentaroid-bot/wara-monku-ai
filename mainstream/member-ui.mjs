import QRCode from "qrcode";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import {
  beginAuth,
  resolveWallet,
  normalizePhone,
  managedSession,
  rememberSession, mobileBrowser,
  connectPhantom,
  openPair,
  deviceProfile,
  recoverySigner,
  signout,
} from "./identity.mjs";
import { questions, walletMessage } from "../shared/member-wire.mjs";
import { transcript, toBase64 } from "../shared/auth-wire.mjs";
import { scannerBox } from "./scan.mjs";

const newSecret = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
const newCards = () => ({
  card: newSecret(),
  codes: Array.from({ length: 6 }, newSecret),
});
export async function memberApi(op, body = {}) {
  const response = await fetch("/api/member/" + op, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...(op === "shop-profiles" ? {signal:AbortSignal.timeout(8000)} : {}),
    keepalive: op === "signature" || (op === "enroll" && body.type === "phantom"),
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify({ ...body, ...(op==="signature" || (op==="enroll" && body.type==="phantom") ? {mobileReturn:mobileBrowser()} : {}), session: managedSession()?.session }),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(result.error || "手続きを完了できませんでした。");
  return result;
}
const cancel = () =>
  Object.assign(Error("取り消しました。"), { cancelled: true });
function dialog(title) {
  const el = document.createElement("dialog");
  const heading = document.createElement("h2");
  heading.textContent = title;
  const box = document.createElement("section"),
    status = document.createElement("p"),
    back = document.createElement("button");
  status.setAttribute("role", "status");
  back.textContent = "取り消す";
  back.className = "secondary";
  el.append(heading, box, status, back);
  document.body.append(el);
  el.showModal();
  const result = new Promise((resolve, reject) => {
    el.finish = (value) => {
      el.close();
      el.remove();
      resolve(value);
    };
    const stop = () => {
      el.close();
      el.remove();
      reject(cancel());
    };
    el.oncancel = (e) => {
      e.preventDefault();
      stop();
    };
    back.onclick = stop;
  });
  return { el, box, status, back, result };
}
export function keypad(title, detail = "") {
  const d = dialog(title);
  const text = document.createElement("p");
  text.textContent = detail;
  const input = document.createElement("input");
  input.type = "password";
  input.inputMode = "numeric";
  input.maxLength = 6;
  input.autocomplete = "off";
  input.className = "pin-dots";
  input.placeholder = "○ ○ ○ ○ ○ ○";
  input.setAttribute("aria-label", title);
  const keys = document.createElement("div");
  keys.className = "pin-keys";
  const update = () => {
    input.value = input.value.replace(/[^0-9]/g, "").slice(0, 6);
    if (input.value.length === 6) d.el.finish(input.value);
  };
  input.oninput = update;
  const digits = Array.from({ length: 10 }, (_, i) => String(i));
  for (let i = 9; i > 0; i--) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [digits[i], digits[n]] = [digits[n], digits[i]];
  }
  for (const v of [...digits.slice(0, 9), "戻す", digits[9], "消す"]) {
    const button = document.createElement("button");
    button.textContent = v;
    button.type = "button";
    button.onclick = () => {
      input.value =
        v === "戻す"
          ? input.value.slice(0, -1)
          : v === "消す"
            ? ""
            : input.value + v;
      update();
    };
    keys.append(button);
  }
  d.box.append(text, input, keys);
  return d.result;
}
async function choosePin() {
  const pin = await keypad(
    "財布の暗証番号を決める",
    "ご本人が覚えられる数字を6つ押してください。",
  );
  if ((await keypad("もう一度、同じ6桁を押す")) !== pin)
    throw Error("2回の暗証番号が違います。もう一度お試しください。");
  return pin;
}
async function signature(address, purpose, nonce, origin = location.origin) {
  const p = await connectPhantom(address),
    a = String(p.publicKey);
  const res = await p.signMessage(
    walletMessage(origin, purpose, nonce, a),
    "utf8",
  );
  return { address: a, signature: toBase64(res.signature) };
}
async function logged(result) {
  if (result.signatureTicket)
    result = await memberApi("signature", {
      ticket: result.signatureTicket,
      ...(await signature(
        result.address,
        "signin",
        result.signatureTicket,
        result.audience,
      )),
    });
  if (managedSession()?.session !== result.session) signout();
  rememberSession(result);
}
function panel(el, title, body, onSubmit, info) {
  el.innerHTML = "<h1></h1><form><fieldset>" + body + "</fieldset></form>";
  el.querySelector("h1").textContent = title;
  const form = el.querySelector("form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const field = form.querySelector("fieldset");
    if (field.disabled) return;
    const values = Object.fromEntries(new FormData(form));
    field.disabled = true;
    info("");
    try {
      await onSubmit(values);
    } catch (err) {
      info(err.message);
    } finally {
      field.disabled = false;
    }
  };
  return form;
}
const phoneField =
  '<label>携帯電話番号<input type="tel" name="phone" autocomplete="tel" required></label>';
async function smsFlow(el, info, mode, intent, done) {
  panel(
    el,
    "電話番号を確認",
    phoneField +
      (mode === "google"
        ? "<p>SMS確認のためGoogleが電話番号を受け取り、保存します。</p>"
        : "") +
      '<div id="captcha"></div><button>確認コードを受け取る</button>',
    async (v) => {
      const phone = normalizePhone(v.phone);
      const auth = await beginAuth(phone, intent, mode);
      if (mode === "google") {
        const { sendPhoneCode } = await import("/v3/google-phone.js");
        auth.confirmPhone = await sendPhoneCode(
          auth.firebase,
          phone,
          el.querySelector("#captcha"),
        );
      }
      panel(
        el,
        "電話番号を確認",
        '<p data-code></p><label>SMSの確認コード<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button>次へ</button><button type="button" data-retry>再送する</button>',
        async ({ code }) => done(phone, await resolveWallet(phone, auth, code)),
        info,
      );
      el.querySelector("[data-code]").textContent = auth.trialCode
        ? "試験用コード：" + auth.trialCode
        : "SMSに届いた6桁を入力してください。";
      el.querySelector("[data-retry]").onclick = () =>
        smsFlow(el, info, mode, intent, done);
    },
    info,
  );
}
const nameField =
  '<label>氏名<input name="name" maxlength="80" autocomplete="off" required></label>';
const aliasFields =
  nameField +
  "<p>ご本人が覚えている質問に3つ以上答えてください。</p>" +
  questions
    .map(
      (q, i) =>
        "<label>" +
        q +
        '<input maxlength="100" name="answer' +
        i +
        '" autocomplete="off"></label>',
    )
    .join("");
const aliasData = (v) => ({
  name: v.name,
  answers: questions.map((_, i) => v["answer" + i] || ""),
});
function quizData(v) {
  const data = aliasData(v);
  if (data.answers.filter((v) => v.trim()).length < 3)
    throw Error("質問に3つ以上答えてください。");
  return data;
}
function secretScan(kind, title) {
  const d = dialog(title);
  scannerBox(d.box, kind, (value) => d.el.finish(value));
  d.box.querySelector("details").open = true;
  return d.result;
}
// Print the recovery material before the operation that creates or rotates it.
async function prepareCards(el, info, values, save, done, address = "") {
  el.innerHTML =
    '<section class="issued"><h1>本人に渡すカード</h1><p>毎日のINAカードと、別に保管する大事な手続き用の紙を印刷してください。</p><div data-cards></div><button data-print>印刷する</button> <button data-save disabled>控えました。登録を確定</button></section>';
  const box = el.querySelector("[data-cards]");
  async function card(label, value) {
    const item = document.createElement("article"),
      h = document.createElement("h3"),
      img = document.createElement("img");
    h.textContent = label;
    img.alt = label;
    img.width = 150;
    img.src = await QRCode.toDataURL(value);
    item.append(h, img);
    box.append(item);
  }
  await card("毎日のINAカード", "wara:ina:" + values.card);
  if (address) {
    const p = document.createElement("p");
    p.className = "wrap";
    p.textContent = address;
    box.append(p);
  }
  const separate = document.createElement("h2");
  separate.className = "separate-sheet";
  separate.textContent = "大事な手続き用：毎日のカードと別に保管";
  box.append(separate);
  for (const [i, code] of values.codes.entries())
    await card(
      i === 5
        ? "カードの再発行専用"
        : "大事な手続き用 " + (i + 1) + "（一回限り）",
      "wara:confirm:" + code,
    );
  el.querySelector("[data-print]").onclick = () => print();
  const button = el.querySelector("[data-save]");
  button.disabled = false;
  button.onclick = async () => {
    button.disabled = true;
    try {
      await save();
      el.replaceChildren();
      await done();
    } catch (err) {
      info(err.message);
      button.disabled = false;
    }
  };
}
function phoneEntry(el, info, mode, intent) {
  return smsFlow(el, info, mode, intent, async (phone, step) => {
    const challenge = {
      phoneHash: step.phoneHash,
      challengeId: step.challengeId,
    };
    if (step.managed) {
      let pending;
      panel(
        el,
        "財布を開く",
        "<button>いつもの暗証番号を入力</button>",
        async () => {
          if (!pending)
            pending = await memberApi("phone-login", {
              ...challenge,
              pin: await keypad("財布の暗証番号"),
            });
          if (pending.signatureTicket)
            el.querySelector("button").textContent =
              "登録済みのPhantomで署名する";
          await logged(pending);
          location.replace(managedSession()?.profile.type==="phantom" ? "/account/" : "/");
        },
        info,
      );
      el.querySelector("form").requestSubmit();
      return;
    }
    const legacy = step.action === "signin";
    const device = !legacy && (await deviceProfile(phone));
    const known = legacy ? step.type : device?.type;
    const select = known
      ? ""
      : '<label>財布の種類<select name="type"><option value="phantom">Phantom</option><option value="embedded">組み込みウォレット</option></select></label>';
    const password =
      known && known !== "phantom"
        ? '<label>これまでのウォレット用パスワード<input name="pass" type="password" required></label>'
        : "";
    panel(
      el,
      legacy || device ? "今の財布に暗証番号を設定" : "新しい財布を作る",
      select +
        password +
        "<p>組み込み・紙の財布はサイトが鍵を暗号化して保管し、暗証番号などの確認後に署名します。Phantomはご本人のアプリで署名します。</p><button>暗証番号を設定して続ける</button>",
      async (v) => {
        const type = known || v.type,
          pin = await choosePin();
        let values,
          proof = {},
          old = device;
        if (type === "phantom")
          proof = await signature(
            step.address || device?.address,
            "register",
            step.challengeId,
            step.audience,
          );
        else {
          values = newCards();
          if (legacy) {
            const signer = await recoverySigner(v.pass, step.phoneHash);
            const signed = await signer.sign(
              transcript(
                "signin",
                step.audience,
                step.phoneHash,
                step.challengeId,
              ),
            );
            old = (
              await memberApi("legacy-vault", { ...challenge, proof: signed })
            ).profile;
          }
          if (old)
            proof.seed = toBase64(
              (await openPair(old, v.pass)).secretKey.subarray(0, 32),
            );
        }
        const save = async () =>
          logged(
            await memberApi("enroll", {
              ...challenge,
              type,
              legacy,
              pin,
              ...values,
              ...proof,
            }),
          );
        if (values)
          await prepareCards(
            el,
            info,
            values,
            save,
            () => location.assign("/account/"),
            old?.address,
          );
        else {
          await save();
          location.replace(managedSession()?.profile.type==="phantom" ? "/account/" : "/");
        }
      },
      info,
    );
  });
}
export function memberSignup(el, info, mode) {
  el.innerHTML =
    '<h1>登録・サインイン</h1><section><button data-phone>電話番号でサインイン</button><button data-name>お名前でサインイン</button><button class="secondary" data-new>電話番号で新規登録</button><p>携帯をお持ちでない方の新規登録は、紹介者のアカウントから行います。</p></section>';
  el.querySelector("[data-phone]").onclick = () =>
    phoneEntry(el, info, mode, "signin");
  el.querySelector("[data-new]").onclick = () =>
    phoneEntry(el, info, mode, "activate");
  el.querySelector("[data-name]").onclick = () => {
    const form = panel(
      el,
      "お名前でサインイン",
      nameField +
        '<details><summary>同姓同名の方</summary><label>財布の公開アドレス（または下でカードを読む）<input name="address" autocomplete="off"></label></details><button>次へ</button>',
      async (v) => {
        const step = await memberApi("questions", v);
        panel(
          el,
          "いつもの質問",
          step.ids
            .map(
              (id, i) =>
                "<label>" +
                questions[id] +
                '<input name="a' +
                i +
                '" autocomplete="off" maxlength="100" required></label>',
            )
            .join("") + "<button>暗証番号へ</button>",
          async (answers) => {
            const pin = await keypad("財布の暗証番号");
            await logged(
              await memberApi("name-login", {
                ticket: step.ticket,
                answers: [answers.a0, answers.a1],
                pin,
              }),
            );
            location.replace(managedSession()?.profile.type==="phantom" ? "/account/" : "/");
          },
          info,
        );
      },
      info,
    );
    scannerBox(form.querySelector("details"), "ina", async (card) => {
      form.elements.address.value = (
        await memberApi("card-info", { card })
      ).address;
    });
  };
}
async function editProof(m, op) {
  if (m.profile.type !== "phantom")
    return { code: await secretScan("confirm", "大事な手続き用QRを読む") };
  const { ticket, audience } = await memberApi("edit-proof", { purpose: op });
  return {
    ticket,
    ...(await signature(m.profile.address, op, ticket, audience)),
  };
}
export function accountTools(el, info, mode) {
  const m = managedSession(),
    box = document.createElement("section");
  box.className = "account-settings";
  box.innerHTML = `<h2>アカウントの設定</h2><p>電話番号連携：${m.hasPhone ? "登録済み" : "未登録"}</p>`;
  el.append(box);
  const button = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try {
        info("");
        await fn();
      } catch (e) {
        info(e.message);
      } finally {
        b.disabled = false;
      }
    };
    box.append(b);
  };
  if (m.hasPhone && ["sms", "google"].includes(mode))
    button("家族・知人の財布を作る", () =>
      panel(
        el,
        "ご本人の財布を作る",
        "<p>ここでご本人に端末を渡してください。氏名・質問の答え・暗証番号は、ご本人が入力します。</p>" +
          aliasFields +
          "<p>鍵はサイトが暗号化して保管します。紹介できるのは24時間に3人までです。</p><button>本人の暗証番号へ</button>",
        async (v) => {
          const data = quizData(v),
            pin = await choosePin(),
            values = newCards();
          await prepareCards(
            el,
            info,
            values,
            () => memberApi("introduce", { ...data, pin, ...values }),
            () => { sessionStorage.setItem("wara.introduced", "yes"); location.replace("/account/"); },
          );
        },
        info,
      ),
    );
  async function edit(op, body) {
    await memberApi(op, { ...body, ...(await editProof(m, op)) });
    signout();
    location.replace("/signup/");
  }
  button("お名前と質問を登録・変更", () =>
    panel(
      el,
      "お名前と質問",
      aliasFields + "<button>登録する</button>",
      (v) => edit("alias", quizData(v)),
      info,
    ),
  );
  if (!m.hasPhone && mode !== "trial")
    button("携帯電話番号を追加", () =>
      smsFlow(el, info, mode, "activate", async (_, step) => {
        if (step.action !== "activate")
          throw Error("この番号はすでに登録されています。");
        await edit("link", {
          phoneHash: step.phoneHash,
          challengeId: step.challengeId,
        });
      }),
    );
  button("暗証番号を変更", async () =>
    edit("pin", { newPin: await choosePin() }),
  );
  if (m.profile.type !== "phantom")
    button("紛失したカードを無効にして再発行", async () => {
      const proof = await editProof(m, "cards"),
        values = newCards();
      await prepareCards(
        el,
        info,
        values,
        () => memberApi("cards", { ...values, ...proof }),
        () => {
          signout();
          location.replace("/signup/");
        },
        m.profile.address,
      );
    });
}
export function siteSigner(profile, checkout = null) {
  return {
    publicKey: new PublicKey(profile.address),
    async signTransaction(tx) {
      const op = checkout ? "card-sign" : "sign",
        payload = {
          tx: toBase64(
            tx.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            }),
          ),
        };
      if (checkout) Object.assign(payload, checkout);
      else {
        const last = tx.instructions.at(-1);
        if (
          !(last.data[0] === 14 || (last.data[0] === 12 && last.data[1] === 0))
        )
          payload.code = await secretScan("confirm", "大事な手続き用QRを読む");
      }
      const res = await memberApi(op, payload);
      tx.addSignature(
        new PublicKey(profile.address),
        Buffer.from(res.signature, "base64"),
      );
      return tx;
    },
  };
}
export async function payWithCard(group, store, amount, title, memo = "") {
  const card = await secretScan("ina", "本人のINAカードを読む");
  const { address } = await memberApi("card-info", { card });
  const [{ loadState, submit, program }, { spend }] = await Promise.all([
    import("./network.mjs"),
    import("./protocol.mjs"),
  ]);
  const state = await loadState(address, true);
  if (state.remaining < BigInt(amount))
    throw Error("今日のINAの残りを超えています。");
  const checkout = { group, store, amount, memo };
  const pin = await keypad(
    "支払いの暗証番号",
    title + " に " + amount + " INAを支払います。" + (memo ? " 💬「" + memo + "」" : ""),
  );
  const p = { address, managed: true };
  return submit(
    p,
    () => siteSigner(p, { card, pin, checkout }),
    spend(
      program,
      address,
      group,
      store,
      BigInt(amount),
      state.day,
      state.nonce,
      memo,
    ),
  );
}
