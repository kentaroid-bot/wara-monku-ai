import bs58 from "bs58";
import { toBase64, fromBase64 } from "../shared/auth-wire.mjs";
import { questions, normal, sessionLifetimeSeconds, walletMessage } from "../shared/member-wire.mjs";

export const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const secret = () => bs58.encode(random(32));
export function validSecret(s) {
  return (
    typeof s === "string" &&
    s.length >= 32 &&
    s.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(s) &&
    bs58.decode(s).length === 32
  );
}
export function pairOf(values) {
  const pool = [...values],
    pick = () =>
      pool.splice(
        crypto.getRandomValues(new Uint32Array(1))[0] % pool.length,
        1,
      )[0];
  return [pick(), pick()];
}

// Per binding: no member/session data is retained between requests.
const ticketCleanupTimes = new WeakMap();
export async function cleanupTickets(db, now) {
  const last = ticketCleanupTimes.get(db);
  if (last !== undefined && now >= last && now - last < 60) return;
  // Claim the interval before awaiting so concurrent requests skip the same sweep.
  ticketCleanupTimes.set(db, now);
  try {
    await db.prepare("DELETE FROM wallet_tickets WHERE expires<=?").bind(now).run();
  } catch (error) {
    ticketCleanupTimes.delete(db);
    throw error;
  }
}

export async function memberCore(b, ctx) {
  const {
    env,
    req,
    origin,
    key,
    now,
    mac,
    limit,
    fail,
    denied,
    bad,
    checkSignature,
  } = ctx;
  const db = env.DB,
    realm = env.AUTH_MODE === "trial" ? "trial" : "verified";
  const query = (sql, ...args) => db.prepare(sql).bind(...args);
  const hash = (purpose, value) =>
    mac(key, "wallet-access/" + realm + "/" + purpose, value);
  const ip = await hash("ip", req.headers.get("CF-Connecting-IP") || "local");
  const limited = (scope, max) =>
    limit(db, "access:" + realm + ":" + scope, now, max);
  if (!b || typeof b !== "object" || Array.isArray(b)) bad();
  await limited("ip:" + ip, 180);
  await cleanupTickets(db, now);
  const phoneKey = async () => {
    if (typeof b.phoneHash !== "string" || !/^[a-f0-9]{64}$/.test(b.phoneHash))
      bad();
    return mac(key, realm === "verified" ? "sms-phone" : "phone", b.phoneHash);
  };
  async function consumePhone(action, consume = true) {
    const phone = await phoneKey();
    const row = await query(
      (consume ? "DELETE FROM challenges" : "SELECT id FROM challenges") +
        " WHERE id=? AND phone_key=? AND action=? AND code_mac=? AND expires>?" +
        (consume ? " RETURNING id" : ""),
      b.challengeId,
      phone,
      action,
      "verified:" + env.AUTH_MODE,
      now,
    ).first();
    if (!row) denied();
    return phone;
  }
  async function ticket(purpose, detail, seconds = 300) {
    const token = secret();
    await query(
      "INSERT INTO wallet_tickets VALUES(?,?,?,?,?)",
      await hash("ticket", token),
      realm,
      purpose,
      JSON.stringify(detail),
      now + seconds,
    ).run();
    return token;
  }
  async function readTicket(token, purpose, consume = true) {
    if (!validSecret(token)) denied();
    const condition = " WHERE token=? AND realm=? AND purpose=? AND expires>?";
    const row = await query(
      consume
        ? "DELETE FROM wallet_tickets" + condition + " RETURNING detail"
        : "SELECT detail FROM wallet_tickets" + condition,
      await hash("ticket", token),
      realm,
      purpose,
      now,
    ).first();
    if (!row) denied();
    return JSON.parse(row.detail);
  }
  const byId = (id) =>
    query("SELECT * FROM members WHERE id=? AND realm=?", id, realm).first();
  const profile = (m) => ({ managed: true, type: m.type, address: m.address });
  async function session(token = b.session) {
    const grant = await readTicket(token, "session", false);
    const m = await byId(grant.id);
    if (!m || grant.revision !== m.revision) denied();
    return { m, grant };
  }
  async function logged(m, phoneLogin) {
    return {
      profile: profile(m),
      phoneLogin,
      hasPhone: Boolean(m.phone_key),
      remainingMs: sessionLifetimeSeconds * 1000,
      expires: (now + sessionLifetimeSeconds) * 1000,
      session: await ticket(
        "session",
        { id: m.id, revision: m.revision, phoneLogin },
        sessionLifetimeSeconds,
      ),
    };
  }
  function validPin(pin) {
    if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) bad();
  }
  async function checkPin(m, pin) {
    validPin(pin);
    await limited("pin:" + m.id, 12);
    if (m.pin_mac !== (await hash("pin", m.id + ":" + pin))) denied();
  }
  async function encryptSeed(id, value, decrypt = false) {
    const aes = await crypto.subtle.importKey(
      "raw",
      fromBase64(await hash("vault", id)),
      "AES-GCM",
      false,
      [decrypt ? "decrypt" : "encrypt"],
    );
    if (decrypt) {
      const [iv, ct] = value.split(".");
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64(iv) },
          aes,
          fromBase64(ct),
        ),
      );
    }
    const iv = random(12);
    return (
      toBase64(iv) +
      "." +
      toBase64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, value))
    );
  }
  async function alias(id) {
    const name = normal(b.name);
    if (
      !name ||
      name.length > 80 ||
      !Array.isArray(b.answers) ||
      b.answers.length !== questions.length
    )
      bad();
    const answers = {};
    for (const [i, text] of b.answers.entries()) {
      const value = normal(text);
      if (value.length > 100) bad();
      if (value) answers[i] = await hash("answer", id + ":" + i + ":" + value);
    }
    if (Object.keys(answers).length < 3)
      fail(400, "質問に3つ以上答えてください。");
    return {
      nameKey: await hash("name", name),
      answers: JSON.stringify(answers),
    };
  }
  async function phantom(m, nonce, purpose) {
    await checkSignature(
      bs58.decode(m.address),
      b.signature,
      walletMessage(origin, purpose, nonce, m.address),
    );
  }
  function cardValues() {
    if (
      !validSecret(b.card) ||
      !Array.isArray(b.codes) ||
      b.codes.length !== 6 ||
      !b.codes.every(validSecret) ||
      new Set([b.card, ...b.codes]).size !== 7
    )
      bad();
  }
  async function codeStatements(id) {
    return Promise.all(
      b.codes.map(async (code, index) =>
        query(
          "INSERT INTO wallet_codes VALUES(?,?,?)",
          id,
          await hash("strong", code),
          Number(index === 5),
        ),
      ),
    );
  }
  async function strong(m, purpose) {
    if (m.type === "phantom") {
      const g = await readTicket(b.ticket, "edit");
      if (g.id !== m.id || g.purpose !== purpose || g.revision !== m.revision)
        denied();
      await phantom(m, b.ticket, purpose);
    } else {
      if (!validSecret(b.code)) denied();
      const used = await query(
        "DELETE FROM wallet_codes WHERE member_id=? AND code_key=? AND (reserve=0 OR ?='cards') RETURNING member_id",
        m.id,
        await hash("strong", b.code),
        purpose,
      ).first();
      if (!used) denied();
    }
  }
  return { ...ctx, b, db, realm, query, hash, limited, phoneKey, consumePhone,
    ticket, readTicket, byId, profile, session, logged, validPin, checkPin,
    encryptSeed, alias, phantom, cardValues, codeStatements, strong };
}
