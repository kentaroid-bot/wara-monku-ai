import manifest from "../shared/deployment.mjs";
import { addr, parseRow, pk } from "../shared/protocol.mjs";
import { shopFields } from "../shared/shop-profile.mjs";

const program = pk(manifest.program);
export function address(value, fail) {
  try { if (typeof value === "string" && pk(value).toBase58() === value) return value; } catch {}
  fail(400, "アドレスの形式を確認してください。");
}

export function decode(account, id) {
  return account?.owner.equals(program) ? parseRow(account.data, id) : null;
}

export async function saveShop(db, rpc, realm, viewer, payload, fail) {
  const group = address(payload.group, fail), merchant = address(payload.store, fail);
  if (viewer !== merchant) fail(403, "店舗を編集できるのは店主本人です。");
  const {revision} = payload;
  if (!Number.isSafeInteger(revision) || revision < 0) fail(400, "店舗情報を更新してから編集してください。");
  let fields;
  try { fields = shopFields(payload); } catch { fail(400, "店舗プロフィールの入力を確認してください。"); }
  const shop = addr(program, "s3", group, merchant);
  let shopAccount;
  try {
    shopAccount = await rpc.getAccountInfo(shop, "confirmed");
  } catch {
    fail(503, "Devnetから店舗情報を取得できませんでした。少し待ってから再試行してください。");
  }
  const row = decode(shopAccount, String(shop));
  if (row?.tag !== 32 || row.to !== merchant || row.group !== group) fail(403, "公認店舗を確認できません。");
  const values = [fields.title, fields.caption, fields.icon, Number(fields.is_test)];
  const stmt = revision === 0
    ? db.prepare("INSERT INTO shop_profiles(realm,shop,group_id,merchant,title,caption,icon,is_test,revision) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT DO NOTHING")
      .bind(realm,String(shop),group,merchant,...values)
    : db.prepare("UPDATE shop_profiles SET title=?,caption=?,icon=?,is_test=?,revision=revision+1 WHERE realm=? AND shop=? AND revision=?")
      .bind(...values,realm,String(shop),revision);
  if ((await stmt.run()).meta.changes !== 1) fail(409, "別の画面で変更されています。「更新」で読み直してください。");
  return {...fields,shop:String(shop),revision:revision+1};
}

export async function readShops(db, rpc, realm, viewer, ids, fail) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 32) fail(400, "店舗の指定を確認してください。");
  const keys = [...new Set(ids.map(id => address(id,fail)))];
  const {results} = await db.prepare("SELECT * FROM shop_profiles WHERE realm=? AND shop IN (" + keys.map(()=>"?").join(",") + ")")
    .bind(realm,...keys).all();
  if (!results.length) return {profiles:[]};
  // Group visibility can change after an edit. Return a private profile only
  // to its merchant, community administrator or an admitted wallet.
  const groups = [...new Set(results.map(row=>row.group_id))];
  const memberships = viewer ? groups.map(group=>addr(program,"m3",group,viewer)) : [];
  let accounts;
  try {
    accounts = await rpc.getMultipleAccountsInfo([...groups.map(pk),...memberships],"confirmed");
  } catch {
    fail(503, "Devnetからコミュニティ情報を取得できませんでした。少し待ってから再試行してください。");
  }
  const allowed = new Set(groups.filter((group,i)=>{
    const g = decode(accounts[i],group);
    if (g?.tag !== 31) return false;
    if (g.visibility !== "private" || g.owner === viewer) return true;
    const member = decode(accounts[i+groups.length],String(memberships[i]));
    return member?.tag === 33 && member.group === group && member.to === viewer && member.status === 2;
  }));
  return {profiles:results.filter(row=>allowed.has(row.group_id) || row.merchant === viewer)
    .map(({shop,title,caption,icon,is_test,revision})=>({shop,title,caption,icon,is_test:Boolean(is_test),revision}))};
}
