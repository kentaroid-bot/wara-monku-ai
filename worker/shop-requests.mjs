import { assertDevnet } from "../app/protocol.mjs";
import manifest from "../deployments/devnet.json" with { type: "json" };
import { addr, pk } from "../mainstream/protocol.mjs";
import { address, decode } from "./shop-profiles.mjs";

const program = pk(manifest.program);
const pageSize = 40;
const columns = "merchant, title, created_at, request_id";
const shopKey = (group, merchant) => addr(program, "s3", group, merchant);
const isShop = (row, group, merchant) => row?.tag === 32 && row.group === group && row.to === merchant;

function titleForChain(value, fail) {
  const title = typeof value === "string" && value.trim();
  if (!title || [...title].length > 40 || new TextEncoder().encode(title).length > 120 ||
      /[\p{Cc}\u202a-\u202e\u2066-\u2069\uD800-\uDFFF]/u.test(title))
    fail(400, "店舗名は40文字・120バイト以内で入力してください。");
  return title;
}

export async function shopRequests(db, rpc, realm, viewer, method, body, fail) {
  const group = address(body.group, fail);
  const memberKey = addr(program, "m3", group, viewer);
  const ownShop = shopKey(group, viewer);
  await assertDevnet(rpc);
  // v3 groups are initialized program-owned accounts; members and shops are PDAs.
  const [groupAccount, memberAccount, shopAccount] = await rpc.getMultipleAccountsInfo(
    [pk(group), memberKey, ownShop], "confirmed");
  const community = decode(groupAccount, group);
  const member = decode(memberAccount, String(memberKey));
  const admin = community?.owner === viewer;
  if (community?.tag !== 31) fail(404, "コミュニティを確認できません。");
  if (!admin && !(member?.tag === 33 && member.group === group && member.to === viewer && member.status === 2))
    fail(403, "コミュニティへの参加後に操作できます。");
  const certified = isShop(decode(shopAccount, String(ownShop)), group, viewer);
  const scope = [realm, group];
  const remove = row => db.prepare("DELETE FROM shop_requests WHERE realm=? AND group_id=? AND merchant=? AND request_id=?")
    .bind(...scope, row.merchant, row.request_id);

  if (method === "POST") {
    if (body.merchant !== undefined && body.merchant !== viewer) fail(403, "ご本人の財布から申請してください。");
    if (certified) fail(409, "この財布には既に公認店舗があります。");
    const title = titleForChain(body.title, fail);
    await db.prepare(`INSERT INTO shop_requests(realm,group_id,merchant,title,created_at,request_id)
      VALUES(?,?,?,?,?,?) ON CONFLICT(realm,group_id,merchant) DO NOTHING`)
      .bind(...scope, viewer, title, Date.now(), crypto.randomUUID()).run();
    return {accepted:true};
  }

  if (method === "DELETE") {
    if (!admin) fail(403, "管理者だけが申請を処理できます。");
    const merchant = address(body.merchant, fail);
    if (typeof body.request_id !== "string" || !["certified","declined"].includes(body.result))
      fail(400, "申請を選び直してください。");
    if (body.result === "certified") {
      const key = shopKey(group, merchant);
      const row = decode(await rpc.getAccountInfo(key, "confirmed"), String(key));
      if (!isShop(row, group, merchant)) fail(409, "台帳への公認反映を待っています。");
    }
    // An old tab must never remove a subsequent application from the same wallet.
    const removed = await remove(body).run();
    if (!removed.meta.changes && await db.prepare("SELECT 1 FROM shop_requests WHERE realm=? AND group_id=? AND merchant=?")
      .bind(...scope, merchant).first()) fail(409, "申請が更新されています。一覧を読み直してください。");
    return {processed:true};
  }

  const cursor = body.after ? address(body.after, fail) : "";
  const target = body.merchant ? address(body.merchant, fail) : null;
  if (target && !admin && target !== viewer) fail(403, "ご本人の申請だけ確認できます。");
  const query = admin && !target
    ? db.prepare(`SELECT ${columns} FROM shop_requests WHERE realm=? AND group_id=? AND merchant>? ORDER BY merchant LIMIT ?`)
      .bind(...scope, cursor, pageSize + 1)
    : db.prepare(`SELECT ${columns} FROM shop_requests WHERE realm=? AND group_id=? AND merchant=?`).bind(...scope, target || viewer);
  const {results} = await query.all();
  const rows = results.slice(0,pageSize);
  const next = results.length > pageSize ? rows.at(-1).merchant : null;
  if (!rows.length) return {requests:[], certified, next};
  const keys = rows.map(row => shopKey(group, row.merchant));
  const accounts = admin ? await rpc.getMultipleAccountsInfo(keys, "confirmed") : [shopAccount];
  const pending = [], settled = [];
  rows.forEach((row,i) => {
    if (isShop(decode(accounts[i], String(keys[i])), group, row.merchant)) settled.push(remove(row));
    else pending.push(row);
  });
  // Also recovers after a lost DELETE response, a closed tab or manual certification.
  if (settled.length) await db.batch(settled);
  return {requests:pending, certified, next};
}
