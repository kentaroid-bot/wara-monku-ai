import bs58 from "bs58";
import { fromBase64, toBase64, transcript } from "../shared/auth-wire.mjs";

const ttl = 300,
  windowSeconds = 900,
  maxBody = 4096;
const enc = new TextEncoder();
class Failure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, text) => {
  throw new Failure(status, text);
};
const denied = () =>
  fail(
    401,
    "確認情報を照合できません。確認コードとサインイン方法を確認してください。",
  );
const bad = () => fail(400, "リクエストの形式を確認してください。");
function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Wara-Auth": "1",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function fields(value, names) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !names.includes(k)) ||
    names.some((k) => !Object.hasOwn(value, k))
  )
    bad();
}
function binary(value, length) {
  if (typeof value !== "string" || value.length !== 4 * Math.ceil(length / 3))
    bad();
  try {
    const b = fromBase64(value);
    if (b.length === length && toBase64(b) === value) return b;
  } catch {}
  bad();
}
async function bodyOf(req) {
  if (
    req.headers.get("content-type")?.split(";")[0].trim() !== "application/json"
  )
    fail(415, "JSONで送信してください。");
  if (Number(req.headers.get("content-length")) > maxBody)
    fail(413, "データが大きすぎます。");
  const reader = req.body?.getReader();
  if (!reader) bad();
  const buf = new Uint8Array(maxBody);
  let len = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (len + value.length > maxBody) {
      await reader.cancel();
      fail(413, "データが大きすぎます。");
    }
    buf.set(value, len);
    len += value.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf.subarray(0, len)));
  } catch {
    bad();
  }
}
function validateProfile(p) {
  if (!p || !["embedded", "paper", "phantom"].includes(p.type)) bad();
  fields(
    p,
    p.type === "phantom" ? ["type", "address"] : ["type", "address", "vault"],
  );
  if (typeof p.address !== "string" || p.address.length > 44) bad();
  let address;
  try {
    address = bs58.decode(p.address);
  } catch {
    bad();
  }
  if (address.length !== 32) bad();
  if (p.type !== "phantom") {
    fields(p.vault, ["salt", "iv", "ct"]);
    binary(p.vault.salt, 16);
    binary(p.vault.iv, 12);
    binary(p.vault.ct, 80);
  }
  return address;
}
async function mac(key, purpose, input) {
  return toBase64(
    await crypto.subtle.sign("HMAC", key, enc.encode(purpose + "\n" + input)),
  );
}
async function checkSignature(pub, proof, message) {
  const sig = binary(proof, 64);
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("raw", pub, "Ed25519", false, [
      "verify",
    ]);
    ok = await crypto.subtle.verify("Ed25519", key, sig, message);
  } catch {}
  if (!ok) denied();
}
async function limit(db, bucket, now, max) {
  const row = await db
    .prepare(
      `INSERT INTO issue_limits(bucket,expires,count) VALUES(?,?,1)
    ON CONFLICT(bucket) DO UPDATE SET
    count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
    expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
    WHERE expires<=? OR count<? RETURNING count`,
    )
    .bind(bucket, now + windowSeconds, now, now, now, max)
    .first();
  if (!row) fail(429, "確認の回数が上限に達しました。15分後にお試しください。");
}
async function issue(env, key, phoneKey, req, action, now) {
  if (!["activate", "signin"].includes(action)) bad();
  await limit(
    env.DB,
    "ip:" +
      (await mac(key, "ip", req.headers.get("CF-Connecting-IP") || "local")),
    now,
    60,
  );
  await limit(env.DB, "phone:" + phoneKey, now, 12);
  const id = crypto.randomUUID();
  let n;
  do {
    [n] = crypto.getRandomValues(new Uint32Array(1));
  } while (n >= 4294000000);
  const code = String(n % 1000000).padStart(6, "0"),
    expires = now + ttl;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires<=?").bind(now),
    env.DB.prepare("DELETE FROM issue_limits WHERE expires<=?").bind(now),
    env.DB.prepare(
      "INSERT INTO challenges(id,phone_key,action,code_mac,expires) VALUES(?,?,?,?,?)",
    ).bind(
      id,
      phoneKey,
      action,
      await mac(key, "code", id + ":" + code),
      expires,
    ),
  ]);
  return json({
    challengeId: id,
    expires,
    trialCode: code,
    audience: new URL(req.url).origin,
  });
}
async function redeem(env, key, origin, action, b, phoneKey, now) {
  if (
    typeof b.challengeId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(b.challengeId) ||
    typeof b.code !== "string" ||
    !/^\d{6}$/.test(b.code)
  )
    bad();
  const args = [b.challengeId, phoneKey, action, now];
  // Reserving an attempt in one statement caps concurrent guesses as well.
  const c = await env.DB.prepare(
    `UPDATE challenges SET attempts=attempts+1
    WHERE id=? AND phone_key=? AND action=? AND expires>? AND attempts<5 RETURNING code_mac`,
  )
    .bind(...args)
    .first();
  if (
    !c ||
    c.code_mac !== (await mac(key, "code", b.challengeId + ":" + b.code))
  )
    denied();
  let profile, loginKey;
  if (action === "activate") {
    const address = validateProfile(b.profile);
    profile = b.profile;
    loginKey = b.loginKey;
    const pub = binary(loginKey, 32);
    if (profile.type === "phantom" && toBase64(address) !== loginKey) denied();
    const msg = transcript(
      action,
      origin,
      b.phoneHash,
      b.challengeId,
      profile,
      loginKey,
    );
    await checkSignature(address, b.walletProof, msg);
    if (b.proof !== b.walletProof || toBase64(pub) !== toBase64(address))
      await checkSignature(pub, b.proof, msg);
  } else {
    const stored = await env.DB.prepare(
      "SELECT profile,login_key FROM wallets WHERE phone_key=?",
    )
      .bind(phoneKey)
      .first();
    if (!stored) denied();
    await checkSignature(
      binary(stored.login_key, 32),
      b.proof,
      transcript(action, origin, b.phoneHash, b.challengeId),
    );
    profile = JSON.parse(stored.profile);
  }
  // Only the winner of this claim may register a wallet or receive ciphertext.
  const claim = await env.DB.prepare(
    "DELETE FROM challenges WHERE id=? AND phone_key=? AND action=? AND expires>? RETURNING id",
  )
    .bind(b.challengeId, phoneKey, action, Math.floor(Date.now() / 1000))
    .first();
  if (!claim) denied();
  if (action === "activate") {
    const result = await env.DB.prepare(
      "INSERT INTO wallets(phone_key,profile,login_key) VALUES(?,?,?) ON CONFLICT(phone_key) DO NOTHING",
    )
      .bind(phoneKey, JSON.stringify(profile), loginKey)
      .run();
    if (result.meta.changes !== 1)
      fail(
        409,
        "この番号にはウォレットが登録済みです。サインインしてください。",
      );
    return json({ address: profile.address }, 201);
  }
  return json({ profile });
}
const common = ["phoneHash", "challengeId", "code", "proof"];
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === "/api/auth/status" && req.method === "GET")
        return json({ service: "wara-auth", version: 1 });
      const action = url.pathname.match(
        /^\/api\/auth\/(challenge|activate|signin)$/,
      )?.[1];
      if (!action) fail(404, "APIが見つかりません。");
      if (req.method !== "POST") fail(405, "POSTを使用してください。");
      const origin = req.headers.get("Origin");
      if (origin && origin !== url.origin)
        fail(403, "同じサイトから操作してください。");
      if (
        env.AUTH_MODE !== "trial" ||
        typeof env.AUTH_PEPPER !== "string" ||
        env.AUTH_PEPPER.length < 32 ||
        !env.DB
      )
        fail(503, "この環境の認証APIは準備中です。");
      const b = await bodyOf(req);
      fields(
        b,
        action === "challenge"
          ? ["phoneHash", "action"]
          : action === "activate"
            ? [...common, "profile", "loginKey", "walletProof"]
            : common,
      );
      if (
        typeof b.phoneHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(b.phoneHash)
      )
        bad();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(env.AUTH_PEPPER),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const phoneKey = await mac(key, "phone", b.phoneHash),
        now = Math.floor(Date.now() / 1000);
      return action === "challenge"
        ? await issue(env, key, phoneKey, req, b.action, now)
        : await redeem(env, key, url.origin, action, b, phoneKey, now);
    } catch (e) {
      return json(
        {
          error:
            e instanceof Failure
              ? e.message
              : "認証APIを利用できません。時間をおいて再試行してください。",
        },
        e instanceof Failure ? e.status : 503,
      );
    }
  },
};
