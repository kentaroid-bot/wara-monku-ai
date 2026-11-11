import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const thankYouChips = ["ごちそうさま！ 😋", "いつもありがとう！ ✨", "最高でした！ 👏", "応援してます！ 🔥"];

export function paymentMemo(value) {
  const text = value.trim();
  if ([...text].length > 60 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(text) || /[\uD800-\uDFFF]/u.test(text))
    throw Error("感謝のメッセージは改行なしの60文字以内で入力してください。");
  return text;
}

export function memoInstruction(text) {
  return new TransactionInstruction({programId:memoProgram, keys:[], data:Buffer.from(text,"utf8")});
}

// A receipt must still be readable when an unrelated memo is malformed.
export function readPaymentMemo(bytes) {
  if (!bytes?.length || bytes.length > 240) return null;
  try {
    const text = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
    return text === paymentMemo(text) ? text : null;
  } catch { return null; }
}
