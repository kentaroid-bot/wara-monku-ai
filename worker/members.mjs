import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { toBase64, fromBase64 } from "../shared/auth-wire.mjs";
import { questions, normal, walletMessage } from "../shared/member-wire.mjs";
import {
  ordinaryMessage,
  confirmedMessage,
  decodeTransaction,
  validBlockhash,
} from "./member-transactions.mjs";

const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const secret = () => bs58.encode(random(32));
function validSecret(s) {
  return (
    typeof s === "string" &&
    s.length >= 32 &&
    s.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(s) &&
    bs58.decode(s).length === 32
  );
}
function pairOf(values) {
  const pool = [...values],
    pick = () =>
      pool.splice(
        crypto.getRandomValues(new Uint32Array(1))[0] % pool.length,
        1,
      )[0];
  return [pick(), pick()];
}

export async function memberRequest(op, b, ctx) {
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
  await query("DELETE FROM wallet_tickets WHERE expires<=?", now).run();
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
  async function session() {
    const grant = await readTicket(b.session, "session", false);
    const m = await byId(grant.id);
    if (!m || grant.revision !== m.revision) denied();
    return { m, grant };
  }
  async function logged(m, phoneLogin) {
    const lifetime = 900;
    return {
      profile: profile(m),
      phoneLogin,
      hasPhone: Boolean(m.phone_key),
      expires: (now + lifetime) * 1000,
      session: await ticket(
        "session",
        { id: m.id, revision: m.revision, phoneLogin },
        lifetime,
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
  async function addMember({ phone, sponsor, oldProfile, adoptTrial }) {
    validPin(b.pin);
    const id = crypto.randomUUID(),
      type = sponsor ? "paper" : b.type;
    if (!["paper", "embedded", "phantom"].includes(type)) bad();
    if (oldProfile && oldProfile.type !== type) denied();
    let address,
      sealed = null,
      cardKey = null;
    if (type === "phantom") {
      address = b.address;
      if (typeof address !== "string" || address.length > 44) bad();
      await phantom({ address }, b.challengeId, "register");
    } else {
      cardValues();
      // Existing wallets migrate only after the owner decrypts their old vault.
      const seed = b.seed ? fromBase64(b.seed) : random(32);
      if (seed.length !== 32 || (sponsor && b.seed)) bad();
      address = bs58.encode(ed25519.getPublicKey(seed));
      sealed = await encryptSeed(id, seed);
      cardKey = await hash("card", b.card);
    }
    if (oldProfile && oldProfile.address !== address) denied();
    const a = sponsor ? await alias(id) : {};
    const stmts = [
      query(
        "INSERT INTO members(id,realm,address,type,phone_key,name_key,answers,pin_mac,sealed_seed,card_key,sponsor_id,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        realm,
        address,
        type,
        phone ?? null,
        a.nameKey ?? null,
        a.answers ?? null,
        await hash("pin", id + ":" + b.pin),
        sealed,
        cardKey,
        sponsor?.id ?? null,
        now,
      ),
    ];
    if (type !== "phantom") stmts.push(...(await codeStatements(id)));
    if (phone) {
      const p = JSON.stringify({ address, type, managed: true });
      if (oldProfile && !adoptTrial)
        stmts.push(
          query(
            "UPDATE wallets SET profile=?,login_key='managed' WHERE phone_key=? AND login_key!='managed'",
            p,
            phone,
          ),
        );
      else
        stmts.push(
          query("INSERT INTO wallets VALUES(?,?,'managed')", phone, p),
        );
    }
    if (phone) await consumePhone(b.legacy ? "signin" : "activate");
    try {
      await db.batch(stmts);
    } catch (e) {
      if (String(e.cause ?? e).includes("sponsor_daily_limit"))
        fail(429, "この紹介者は24時間の紹介上限に達しました。");
      if (String(e.cause ?? e).includes("UNIQUE"))
        fail(409, "すでに登録済みです。サインインしてください。");
      throw e;
    }
    const m = await byId(id);
    return sponsor ? { address } : logged(m, true);
  }
  if (op === "enroll") {
    const phone = await consumePhone(b.legacy ? "signin" : "activate", false);
    const existing = await query(
      "SELECT * FROM wallets WHERE phone_key=?",
      phone,
    ).first();
    let old = existing;
    if (!old && b.legacy && realm === "verified")
      old = await query(
        "SELECT * FROM wallets WHERE phone_key=? AND login_key!='managed'",
        await mac(key, "phone", b.phoneHash),
      ).first();
    if (Boolean(old) !== Boolean(b.legacy) || old?.login_key === "managed")
      denied();
    return addMember({
      phone,
      oldProfile: old && JSON.parse(old.profile),
      adoptTrial: old && !existing,
    });
  }
  if (op === "introduce") {
    const { m, grant } = await session();
    if (realm !== "verified" || !m.phone_key || !grant.phoneLogin)
      fail(403, "SMSでサインインした紹介者が必要です。");
    return addMember({ sponsor: m });
  }
  async function finishPin(m, phoneLogin) {
    await checkPin(m, b.pin);
    if (m.type === "phantom")
      return {
        address: m.address,
        audience: origin,
        signatureTicket: await ticket("signature", {
          id: m.id,
          phoneLogin,
          revision: m.revision,
        }),
      };
    return logged(m, phoneLogin);
  }
  if (op === "phone-login") {
    const phone = await phoneKey();
    const m = await query(
      "SELECT * FROM members WHERE phone_key=? AND realm=?",
      phone,
      realm,
    ).first();
    if (!m) denied();
    const row = await query(
      "SELECT id FROM challenges WHERE id=? AND phone_key=? AND action='signin' AND code_mac=? AND expires>?",
      b.challengeId,
      phone,
      "verified:" + env.AUTH_MODE,
      now,
    ).first();
    if (!row) denied();
    await checkPin(m, b.pin);
    await consumePhone("signin");
    if (m.type === "phantom")
      return {
        address: m.address,
        audience: origin,
        signatureTicket: await ticket("signature", {
          id: m.id,
          phoneLogin: true,
          revision: m.revision,
        }),
      };
    return logged(m, true);
  }
  if (op === "signature") {
    const g = await readTicket(b.ticket, "signature", false),
      m = await byId(g.id);
    if (!m || m.revision !== g.revision) denied();
    await limited("signature:" + m.id, 20);
    await phantom(m, b.ticket, "signin");
    await readTicket(b.ticket, "signature");
    return logged(m, g.phoneLogin);
  }
  if (op === "questions") {
    const name = normal(b.name);
    if (!name || name.length > 80) bad();
    const nameKey = await hash("name", name);
    await limited("quiz:" + nameKey, 30);
    const { results } = await query(
      "SELECT id,address,answers,revision FROM members WHERE realm=? AND name_key=? AND (?='' OR address=?) LIMIT 2",
      realm,
      nameKey,
      b.address || "",
      b.address || "",
    ).all();
    const m =
      results.length === 1
        ? results[0]
        : results.find((v) => v.address === b.address);
    const ids = pairOf(
      m
        ? Object.keys(JSON.parse(m.answers)).map(Number)
        : questions.map((_, i) => i),
    );
    return {
      ids,
      ticket: await ticket("quiz", {
        id: m?.id ?? null,
        ids,
        revision: m?.revision,
      }),
    };
  }
  if (op === "name-login") {
    const g = await readTicket(b.ticket, "quiz"),
      m = await byId(g.id);
    if (
      !m ||
      m.revision !== g.revision ||
      !Array.isArray(b.answers) ||
      b.answers.length !== 2
    )
      denied();
    await limited("answers:" + m.id, 12);
    const answers = JSON.parse(m.answers);
    for (const [i, q] of g.ids.entries())
      if (
        answers[q] !==
        (await hash("answer", m.id + ":" + q + ":" + normal(b.answers[i])))
      )
        denied();
    return finishPin(m, false);
  }
  if (op === "logout") {
    await readTicket(b.session, "session");
    return {};
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
  if (op === "edit-proof") {
    const { m } = await session();
    if (
      m.type !== "phantom" ||
      !["alias", "link", "pin", "cards"].includes(b.purpose)
    )
      bad();
    return {
      audience: origin,
      ticket: await ticket("edit", {
        id: m.id,
        purpose: b.purpose,
        revision: m.revision,
      }),
    };
  }
  if (["alias", "link", "pin", "cards"].includes(op)) {
    const { m } = await session();
    const stmts = [];
    if (op === "alias") {
      const a = await alias(m.id);
      stmts.push(
        query(
          "UPDATE members SET name_key=?,answers=? WHERE id=?",
          a.nameKey,
          a.answers,
          m.id,
        ),
      );
    }
    if (op === "link") {
      if (m.phone_key || realm !== "verified")
        fail(409, "電話番号を追加できません。");
      const phone = await consumePhone("activate");
      if (await query("SELECT 1 FROM wallets WHERE phone_key=?", phone).first())
        denied();
      stmts.push(
        query(
          "INSERT INTO wallets VALUES(?,?,'managed')",
          phone,
          JSON.stringify(profile(m)),
        ),
        query(
          "UPDATE members SET phone_key=? WHERE id=? AND phone_key IS NULL",
          phone,
          m.id,
        ),
      );
    }
    if (op === "pin") {
      validPin(b.newPin);
      stmts.push(
        query(
          "UPDATE members SET pin_mac=? WHERE id=?",
          await hash("pin", m.id + ":" + b.newPin),
          m.id,
        ),
      );
    }
    if (op === "cards") {
      if (m.type === "phantom") bad();
      cardValues();
      stmts.push(
        query("DELETE FROM wallet_codes WHERE member_id=?", m.id),
        ...(await codeStatements(m.id)),
        query(
          "UPDATE members SET card_key=? WHERE id=?",
          await hash("card", b.card),
          m.id,
        ),
      );
    }
    await strong(m, op);
    stmts.push(
      query(
        "UPDATE members SET revision=CASE WHEN revision=? THEN revision+1 ELSE NULL END WHERE id=?",
        m.revision,
        m.id,
      ),
    );
    await db.batch(stmts);
    return { reauth: true };
  }
  if (op === "card-info" || op === "card-sign") {
    if (!validSecret(b.card)) denied();
    const m = await query(
      "SELECT * FROM members WHERE realm=? AND card_key=?",
      realm,
      await hash("card", b.card),
    ).first();
    if (!m || m.type === "phantom") denied();
    if (op === "card-info") return { address: m.address };
    await checkPin(m, b.pin);
    return signed(m, true);
  }
  if (op === "sign") {
    const { m } = await session();
    if (m.type === "phantom") denied();
    return signed(m, false);
  }
  async function signed(m, card) {
    let tx, ordinary;
    try {
      tx = decodeTransaction(b.tx, m.address);
      if (card && (!b.checkout || !Number.isInteger(b.checkout.amount))) bad();
      ordinary = ordinaryMessage(
        tx.raw,
        m.address,
        card ? "card" : "session",
        card ? b.checkout : null,
      );
      if (!ordinary && !card && !confirmedMessage(tx.raw, m.address)) denied();
    } catch {
      bad();
    }
    if (card && !ordinary) denied();
    if (!(await validBlockhash(tx.blockhash)))
      fail(400, "Devnetの取引期限を確認してください。");
    if (!card && !ordinary) await strong(m, "payment");
    const seed = await encryptSeed(m.id, m.sealed_seed, true);
    return { signature: toBase64(ed25519.sign(tx.message, seed)) };
  }
  bad();
}
