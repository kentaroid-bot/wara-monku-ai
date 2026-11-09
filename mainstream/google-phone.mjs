import { getApps, initializeApp } from "firebase/app";
import {
  initializeAuth,
  getAuth,
  inMemoryPersistence,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut,
} from "firebase/auth";

export async function sendPhoneCode(config, phone, container) {
  const existing = getApps().find((app) => app.name === "wara-phone");
  const auth = existing
    ? getAuth(existing)
    : initializeAuth(initializeApp(config, "wara-phone"), {
        persistence: inMemoryPersistence,
      });
  auth.languageCode = "ja";
  const captcha = new RecaptchaVerifier(auth, container, { size: "normal" });
  let confirmation;
  try {
    confirmation = await signInWithPhoneNumber(auth, phone, captcha);
  } catch (error) {
    const messages = {
      "auth/invalid-phone-number": "携帯番号を確認してください。日本の番号は090などから始まる数字だけで入力できます。",
      "auth/network-request-failed": "Googleの認証サービスに接続できませんでした。通信状態を確認してください。",
      "auth/captcha-check-failed": "Googleの本人確認を完了できませんでした。ページを再読み込みしてお試しください。",
      "auth/too-many-requests": "GoogleがSMS送信を一時的に制限しています。時間をおいてお試しください。",
      "auth/quota-exceeded": "GoogleのSMS送信上限に達しました。",
      "auth/billing-not-enabled": "Google側でSMS認証の請求設定が有効になっていません。",
      "auth/operation-not-allowed": "Google側の設定でこのSMS認証が許可されていません。",
    };
    const code = error?.code;
    const message = messages[code] ?? "確認SMSを送信できませんでした。";
    throw Error(/^auth\/[a-z][a-z-]{1,64}$/.test(code) ? `${message}（${code}）` : message);
  } finally {
    captcha.clear();
  }

  let token;
  return async function confirm(code) {
    if (token) return token;
    try {
      const { user } = await confirmation.confirm(code);
      token = await user.getIdToken();
      return token;
    } catch {
      throw Error(
        "Googleの確認コードを照合できませんでした。入力を確認するか、コードを再発行してください。",
      );
    } finally {
      if (auth.currentUser) await signOut(auth);
    }
  };
}
