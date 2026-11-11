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
    async load(state) {
      const visible = new Set(state.groups.map(g=>g.id));
      const stores = state.rows.filter(row=>row.tag === 32 && (visible.has(row.group) || row.to === profile.address));
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
      const fields = shopFields({...values, is_test:values.is_test === "on"});
      await auth.authenticate();
      return memberApi("shop-save",{...fields, group:store.group,store:store.to,revision:store.revision || 0,access:auth.token()});
    },
  };
}

export function shopDetails(store, h) {
  return (store.is_test ? '<small class="test-shop">テスト店舗</small>' : "") +
    (store.caption ? '<small class="shop-caption">' + h(store.caption) + '</small>' : "");
}
export function shopTitle(store) {
  return [store.icon,store.name].filter(Boolean).join(" ");
}
export function shopEditor(store, h) {
  return `<details class="shop-editor"><summary>⚙️ 店舗情報を編集</summary><form id="edit-shop">
    <label>店舗名<input name="title" required value="${h(store.name)}"></label>
    <label>一言紹介（140文字まで）<input name="caption" value="${h(store.caption || "")}"></label>
    <label>アイコン<select name="icon">${shopIcons.map(icon=>`<option${icon === store.icon ? " selected" : ""}>${icon}</option>`).join("")}</select></label>
    <label class="shop-check"><input type="checkbox" name="is_test"${store.is_test ? " checked" : ""}>お試し・実験用のレジ</label>
    <button>店舗情報を保存</button></form></details>`;
}
