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
    if (error.code === "auth/too-many-requests")
      throw Error(
        "SMSの送信回数が上限に達しました。時間をおいてお試しください。",
      );
    throw Error(
      "確認SMSを送信できませんでした。電話番号と通信状態を確認してください。",
    );
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
