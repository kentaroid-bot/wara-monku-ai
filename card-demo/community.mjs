export const CATEGORIES = ["地域", "学校", "サークル", "イベント"];

export function initialRegistry() {
  return [
    { id: "midori-shoptown", name: "みどり商店街", category: "地域", description: "",
      shops: [{ id: "S-001", name: "田中商店" }], allies: [], requests: [] },
    { id: "waseda-univ", name: "早稲田大学", category: "学校", description: "",
      shops: [{ id: "S-001", name: "大学売店" }], allies: [], requests: [] },
  ];
}

export function community(state, id) {
  const entry = state.registry.find(c => c.id === id);
  if (!entry) throw Error("コミュニティが見つかりません。");
  return entry;
}

export function merchant(state, id, shopId = "S-001") {
  const shop = community(state, id).shops.find(s => s.id === shopId);
  if (!shop) throw Error("このコミュニティの公認店舗を選んでください。");
  return shop;
}

function checkedText(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw Error(label + "を確認してください。");
  return value.trim();
}

export function createCommunity(state, action) {
  const id = checkedText(action.communityId, 40, "コミュニティID");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || state.registry.some(c => c.id === id))
    throw Error("未使用の半角英小文字・数字・ハイフンのIDを指定してください。");
  const name = checkedText(action.name, 50, "名称");
  if (!CATEGORIES.includes(action.category)) throw Error("カテゴリを選んでください。");
  const description = (action.description || "").trim();
  if (description.length > 240) throw Error("説明は240文字までです。");
  state.registry.push({id, name, category: action.category, description, shops: [], allies: [], requests: []});
  state.communities.push(id);
}

export function addShop(state, action) {
  const c = community(state, action.communityId);
  const name = checkedText(action.name, 50, "店舗名");
  if (c.shops.some(shop => shop.name === name)) throw Error("この店舗はすでに公認済みです。");
  c.shops.push({id: "S-" + String(c.shops.length + 1).padStart(3, "0"), name});
}

export function setAlliance(state, action) {
  const from = community(state, action.communityId);
  const to = community(state, action.peerId);
  if (from === to) throw Error("別のコミュニティを選んでください。");
  if (action.decision === "request") {
    if (from.allies.includes(to.id) || to.requests.includes(from.id) || from.requests.includes(to.id))
      throw Error("すでに提携済み、または申請中です。");
    to.requests.push(from.id);
  } else if (action.decision === "accept" && from.requests.includes(to.id)) {
    from.requests = from.requests.filter(id => id !== to.id);
    from.allies.push(to.id);
    to.allies.push(from.id);
  } else if (action.decision === "remove" && from.allies.includes(to.id)) {
    from.allies = from.allies.filter(id => id !== to.id);
    to.allies = to.allies.filter(id => id !== from.id);
  } else throw Error("現在の提携状態を確認してください。");
}

// Refunds and subsequent transfers are recorded with their original issuer.
export function userFunds(state) {
  const funds = new Map(state.registry.map(c => [c.id, 0]));
  for (const r of state.history) funds.set(r.communityId, funds.get(r.communityId) + r.userRefund);
  for (const t of state.transfers)
    for (const lot of t.origins) funds.set(lot.id, funds.get(lot.id) - lot.amount);
  return funds;
}

export function availableFunds(state, communityId) {
  const c = community(state, communityId), funds = userFunds(state);
  return [c.id, ...c.allies].map(id => ({id, amount: funds.get(id)})).filter(lot => lot.amount > 0);
}

export function transferWara(state, action) {
  const shop = merchant(state, action.communityId, action.shopId);
  if (!action.id || [...state.history, ...state.transfers, state.pending].some(r => r?.id === action.id))
    throw Error("このお会計番号は使用済みです。");
  if (!Number.isSafeInteger(action.amount) || action.amount < 1) throw Error("WARAの金額は正の整数を指定してください。");
  let remaining = action.amount;
  const origins = [];
  for (const lot of availableFunds(state, action.communityId)) {
    const amount = Math.min(lot.amount, remaining);
    origins.push({id: lot.id, amount});
    remaining -= amount;
    if (!remaining) break;
  }
  if (remaining) throw Error("この店で使えるWARAが不足しています。未提携の発行元は受け入れていません。");
  state.transfers.unshift({id: action.id, amount: action.amount, communityId: action.communityId,
    shopId: shop.id, day: state.day, time: action.time, origins});
}
