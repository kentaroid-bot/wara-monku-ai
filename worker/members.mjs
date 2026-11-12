import { shopRequests } from "./shop-requests.mjs";
import { communityReaders } from "./community-read.mjs";
import { readCommunityProfiles, saveCommunityProfile, renameCommunity } from "./community-profiles.mjs";
import { readShops, saveShop } from "./shop-profiles.mjs";
import { workerConnection } from "./devnet-rpc.mjs";
import { feeKey, relayPayment } from "./relay.mjs";
import bs58 from "bs58";
import { walletMessage } from "../shared/member-wire.mjs";
import { memberCore, validSecret } from "./member-core.mjs";
import { memberAuth } from "./member-auth.mjs";
import { memberSettings } from "./member-settings.mjs";
import { memberSigning } from "./member-signing.mjs";

export async function memberRequest(op, b, ctx) {
  const core = await memberCore(b, ctx);
  const { env, req, db, realm, query, hash, limited, session, ticket, readTicket,
    profile, origin, now, checkSignature, bad, denied, fail } = core;
  if (["community-profiles","community-save","community-rename"].includes(op)) {
    const {m} = await session();
    const rpc = workerConnection(env);
    if (op === "community-rename") return renameCommunity(db,rpc,realm,m.address,b,hash,fail);
    return op === "community-save"
      ? saveCommunityProfile(db,rpc,realm,m.address,b,hash,fail)
      : readCommunityProfiles(db,communityReaders(env),realm,m.address,b.groups,hash,fail);
  }
  if (op === "shop-challenge") {
    if (!validSecret(b.address) || bs58.decode(b.address).length !== 32) bad();
    const purpose = b.purpose ?? "shop-profile";
    if (!["shop-profile","shop-requests"].includes(purpose)) bad();
    return {ticket:await ticket("shop-proof", {address:b.address,purpose}), audience:origin};
  }
  if (op === "shop-access") {
    const {address, purpose = "shop-profile"} = await readTicket(b.ticket, "shop-proof");
    await checkSignature(bs58.decode(address), b.proof, walletMessage(origin, purpose, b.ticket, address));
    return {access:await ticket(purpose === "shop-profile" ? "shop-access" : "shop-requests", {address}, 900)};
  }
  if (op === "shopRequests") {
    const auth = /^(Bearer|ShopRequest) ([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(req.headers.get("Authorization") || "");
    if (!auth) denied();
    const viewer = auth[1] === "Bearer" ? (await session(auth[2])).m.address
      : (await readTicket(auth[2], "shop-requests", false)).address;
    return shopRequests(db, workerConnection(env), realm, viewer, req.method, b, fail);
  }
  if (op === "shop-profiles" || op === "shop-save") {
    const viewer = b.session ? (await session()).m.address
      : b.access ? (await readTicket(b.access, "shop-access", false)).address : null;
    const rpc = workerConnection(env);
    if (op === "shop-profiles") return readShops(db, rpc, realm, viewer, b.shops, fail);
    if (!viewer) denied();
    return saveShop(db, rpc, realm, viewer, b, fail);
  }
  if (op === "relay" || op === "relay-status") {
    const { m } = await session();
    const receipts = {
      find: receipt => query("SELECT signature FROM relay_receipts WHERE receipt=?", receipt).first("signature"),
      insert: async (receipt, sig) => (await query("INSERT OR IGNORE INTO relay_receipts VALUES (?,?)", receipt, sig).run()).meta.changes === 1,
    };
    if (op === "relay-status") {
      if (typeof b.receipt !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(b.receipt)) bad();
      return {signature: await receipts.find(b.receipt)};
    }
    const sponsor = feeKey(env);
    if (!sponsor) fail(503, "手数料支援は設定されていません。");
    return relayPayment({encoded:b.tx, sponsor, member:m.address, receipts, fail, rpc:workerConnection(env),
      reserveBudget: async () => {
        await limited("relay-member:" + m.id, 20);
        await limited("relay-global", 200);
      }});
  }
  if (op === "phantom-return") {
    // Authorization is still the original signed session. Never renew it here.
    const token = ctx.returnToken;
    if (!token || req.headers.get("Origin") !== origin) denied();
    const {m, grant} = await session(token);
    if (m.type !== "phantom") denied();
    const row = await query("SELECT expires FROM wallet_tickets WHERE token=? AND purpose='session' AND realm=? AND expires>?",
      await hash("ticket",token),realm,now).first();
    if (!row) denied();
    return {profile:profile(m), session:token, phoneLogin:grant.phoneLogin, hasPhone:Boolean(m.phone_key),
      expires:row.expires * 1000, remainingMs:(row.expires-now)*1000};
  }
  if (["edit-proof", "alias", "link", "pin", "cards"].includes(op))
    return memberSettings(op, core);
  if (["card-info", "card-sign", "sign"].includes(op))
    return memberSigning(op, core);
  return memberAuth(op, core);
}
