import { initialRegistry, merchant, createCommunity, addShop, setAlliance, transferWara } from "./community.mjs";
export const PIN = "123456";
export const DAILY_KUSA = 10;
export const WALLET_TYPES = ["embedded", "phantom"];
const invitations = new Map([["WASEDA2026", "waseda-univ"]]);

export function cardPayload(state) {
  return JSON.stringify({
    type: "wara-card-ui-demo",
    participant: "C-001",
    cardVersion: state.cardVersion,
  });
}

function verifyCard(raw, state) {
  let card;
  try { card = JSON.parse(raw); } catch { /* handled below */ }
  if (card?.type !== "wara-card-ui-demo" || card.participant !== "C-001")
    throw Error("この利用者のKusaカードを読み取ってください。");
  if (card.cardVersion !== state.cardVersion)
    throw Error("このカードは再発行済みです。新しいカードを使用してください。");
}

export function distribution(amount) {
  const issued = amount * 100;
  const userRefund = issued / 10;
  return { shopCredit: issued - userRefund, userRefund };
}

// Both credits in a receipt have the same issuing community.
export function balances(receipts) {
  return receipts.reduce((total, receipt) => ({
    shopWara: total.shopWara + receipt.shopCredit,
    userWara: total.userWara + receipt.userRefund,
  }), { shopWara: 0, userWara: 0 });
}

export const fresh = () => ({
  version: 3,
  registry: initialRegistry(),
  transfers: [],
  walletType: "embedded",
  communities: ["midori-shoptown"],
  day: 1,
  spent: 0,
  cardVersion: 1,
  cardActive: true,
  attempts: 0,
  pending: null,
  history: [],
});
export function transition(state, action) {
  const s = structuredClone(state),
    p = s.pending;
  if (action.type === "createCommunity") createCommunity(s, action);
  else if (action.type === "addShop") addShop(s, action);
  else if (action.type === "setAlliance") setAlliance(s, action);
  else if (action.type === "payWara") transferWara(s, action);
  else if (action.type === "joinCommunity") {
    const id = invitations.get(String(action.code).trim().toUpperCase());
    if (!id) throw Error("招待コードを確認してください。");
    if (s.communities.includes(id)) throw Error("すでに参加しています。");
    s.communities.push(id);
  } else if (action.type === "setWallet") {
    if (!WALLET_TYPES.includes(action.walletType)) throw Error("ウォレット種別が不正です。");
    s.walletType = action.walletType;
  } else if (action.type === "checkout") {
    if (p) throw Error("進行中のお会計を完了または取り消してください。");
    if (!s.cardActive)
      throw Error("カードは停止中です。地域窓口で再発行してください。");
    if (
      !Number.isInteger(action.amount) ||
      action.amount < 1 ||
      action.amount > DAILY_KUSA - s.spent
    )
      throw Error("今日の残りKusaの範囲で、1以上の整数を入力してください。");
    if (!action.id || [...s.history, ...s.transfers].some((x) => x.id === action.id))
      throw Error("このお会計番号は使用済みです。");
    const shop = merchant(s, action.communityId, action.shopId);
    if (!s.communities.includes(action.communityId))
      throw Error("アカウント画面でコミュニティに参加してください。");
    if (action.card !== undefined) verifyCard(action.card, s);
    s.pending = {
      shopId: shop.id,
      communityId: action.communityId,
      id: action.id,
      amount: action.amount,
      day: s.day,
      cardVersion: s.cardVersion,
      status: "confirm",
    };
  } else if (action.type === "cancel") {
    s.pending = null;
  } else if (action.type === "requestSupport") {
    if (!p) throw Error("店でお会計を準備してください。");
    s.pending.status = "support";
  } else if (action.type === "pay" || action.type === "approve") {
    if (!p || p.id !== action.id)
      throw Error("このお会計は終了または変更されています。");
    if (!s.cardActive || p.cardVersion !== s.cardVersion || p.day !== s.day)
      throw Error(
        "カードまたは日付が変わりました。お会計を作り直してください。",
      );
    if (action.type === "pay") {
      if (p.status !== "confirm")
        throw Error("地域窓口での確認を待っています。");
      if (s.attempts >= 3)
        throw Error("3回間違えました。地域窓口の立ち会いを使ってください。");
      if (action.pin !== PIN) {
        s.attempts++;
        return s;
      }
    } else if (p.status !== "support" || !action.consent)
      throw Error("本人と店名・金額への同意を確認してください。");
    if (p.amount > DAILY_KUSA - s.spent) throw Error("今日の残りKusaを超えています。");
    s.spent += p.amount;
    s.attempts = 0;
    s.history.unshift({
      ...p,
      ...distribution(p.amount),
      status: "paid",
      method: action.type === "pay" ? "pin" : "support",
      remaining: DAILY_KUSA - s.spent,
      time: action.time,
    });
    s.pending = null;
  } else if (action.type === "stop") {
    s.cardActive = false;
    s.pending = null;
  } else if (action.type === "reissue") {
    s.cardVersion++;
    s.cardActive = true;
    s.pending = null;
    s.attempts = 0;
  } else if (action.type === "nextDay") {
    s.day++;
    s.spent = 0;
    s.pending = null;
    s.attempts = 0;
  } else throw Error("未対応の操作です。");
  return s;
}
