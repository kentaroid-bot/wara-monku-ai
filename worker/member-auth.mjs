import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { fromBase64 } from "../shared/auth-wire.mjs";
import { questions, normal } from "../shared/member-wire.mjs";
import { random, pairOf } from "./member-core.mjs";

export async function memberAuth(op, core) {
  const { b, env, db, realm, query, hash, limited, phoneKey, consumePhone, ticket,
    readTicket, byId, session, logged, validPin, checkPin, encryptSeed, alias,
    phantom, cardValues, codeStatements, now, mac, key, origin, bad, denied, fail } = core;
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
    const { m } = await session();
    if (realm !== "verified" || !m.phone_key)
      fail(403, "電話番号を登録した紹介者が必要です。");
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
  bad();
}
