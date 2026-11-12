import { shopFields, shopIcons } from "../shared/shop-profile.mjs";
import { memberApi } from "./member-ui.mjs";
import { walletMessage } from "../shared/member-wire.mjs";
import { toBase64 } from "../shared/auth-wire.mjs";

export function shopWalletAccess(profile, wallet, purpose) {
  let access, expires = 0;
  async function authenticate() {
    if (profile.managed || (access && Date.now() < expires)) return;
    const {ticket,audience} = await memberApi("shop-challenge",{address:profile.address, purpose});
    if (audience !== location.origin) throw Error("署名先を確認してください。");
    const signer = await wallet();
    const {signature} = await signer.signMessage(walletMessage(audience,purpose,ticket,profile.address),"utf8");
    ({access} = await memberApi("shop-access",{ticket,proof:toBase64(signature)}));
    expires = Date.now()+14*60_000;
  }
  return {authenticate, token:() => Date.now() < expires ? access : undefined};
}

export function shopProfiles(profile, wallet) {
  const auth = shopWalletAccess(profile, wallet, "shop-profile");
  return {
    authenticate:auth.authenticate,
    async load(state, include = () => true) {
      const visible = new Set(state.groups.map(g=>g.id));
      const stores = state.rows.filter(row=>row.tag === 32 && include(row) && (visible.has(row.group) || row.to === profile.address));
      for (let i=0; i<stores.length; i+=32) {
        const chunk = stores.slice(i,i+32);
        const data = await memberApi("shop-profiles",{shops:chunk.map(row=>row.id), access:auth.token()});
        const profiles = new Map(data.profiles.map(p=>[p.shop,p]));
        for (const row of chunk) {
          const saved = profiles.get(row.id);
          if (saved) Object.assign(row,saved,{name:saved.title});
        }
      }
    },
    async save(store, values) {
      const fields = shopFields({...values, is_test:store.is_test === true});
      await auth.authenticate();
      return memberApi("shop-save",{...fields, group:store.group,store:store.to,revision:store.revision || 0,access:auth.token()});
    },
  };
}

export function shopDetails(store, h) {
  return store.caption ? '<small class="shop-caption">' + h(store.caption) + '</small>' : "";
}
export function shopTitle(store) {
  return [store.icon,store.name].filter(Boolean).join(" ");
}
export function shopEditor(store, h) {
  return `<details class="shop-editor"><summary>⚙️ 店舗情報を編集</summary><form id="edit-shop" data-shop="${h(store.id)}">
    <label>店舗名<input name="title" required value="${h(store.name)}"></label>
    <label>一言紹介（140文字まで）<input name="caption" value="${h(store.caption || "")}"></label>
    <label>アイコン<select name="icon">${shopIcons.map(icon=>`<option${icon === store.icon ? " selected" : ""}>${icon}</option>`).join("")}</select></label>
    <button>店舗情報を保存</button></form></details>`;
}

// Enhance the current DOM after first paint; never replace payment forms or QR.
export async function enhanceShopProfiles(profiles, state, content, h, isCurrent, visibleOnly = false) {
  const labels = [...content.querySelectorAll("[data-shop-label]")];
  const ids = new Set(labels.map(el => el.dataset.shopLabel));
  const editor = content.querySelector("#edit-shop");
  const inputs = editor ? [...editor.querySelectorAll("input, select")].map(el => [el, el.value]) : [];
  if (visibleOnly && !ids.size) return "";
  try {
    await profiles.load(state, visibleOnly ? row => ids.has(row.id) : undefined);
    if (!isCurrent()) return "";
    const stores = new Map(state.rows.filter(r => r.tag === 32).map(r => [r.id, r]));
    for (const el of labels) {
      const store = stores.get(el.dataset.shopLabel);
      if (el.isConnected && store)
        el.innerHTML = h(shopTitle(store)) + (el.dataset.registerLabel ? "のレジ" : "") + shopDetails(store, h);
    }
    const store = stores.get(editor?.dataset.shop);
    if (store && editor.isConnected && !editor.matches(":focus-within") && !editor.dataset.busy) {
      for (const [el, initial] of inputs) {
        if (el.value === initial) el.value = (el.name === "title" ? store.name : store[el.name]) || "";
      }
    }
    return "";
  } catch {
    return "店舗プロフィールを取得できません。「更新」で再試行できます。";
  }
}
