import bs58 from "bs58";
import {
  fromBase64,
  phoneDigest,
  toBase64,
  transcript,
} from "../shared/auth-wire.mjs";

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
function smsReady(env) {
  return (
    /^VA[0-9a-fA-F]{32}$/.test(env.TWILIO_VERIFY_SERVICE_SID || "") &&
    /^SK[0-9a-fA-F]{32}$/.test(env.TWILIO_API_KEY || "") &&
    Boolean(env.TWILIO_API_SECRET)
  );
}
async function verifyRequest(env, path, parameters) {
  const res = await fetch(
    `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + btoa(env.TWILIO_API_KEY + ":" + env.TWILIO_API_SECRET),
      },
      body: new URLSearchParams(parameters),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (res.status === 429)
    fail(429, "SMSの利用が集中しています。時間をおいて再試行してください。");
  if (path === "VerificationCheck" && [400, 404].includes(res.status)) denied();
  if (!res.ok)
    fail(
      503,
      "SMS認証を利用できません。番号を確認し、時間をおいて再試行してください。",
    );
  return res.json();
}
async function issue(env, key, phoneKey, req, action, now, phone) {
  if (!["activate", "signin"].includes(action)) bad();
  await limit(
    env.DB,
    "ip:" +
      (await mac(key, "ip", req.headers.get("CF-Connecting-IP") || "local")),
    now,
    phone ? 10 : 60,
  );
  await limit(env.DB, "phone:" + phoneKey, now, phone ? 3 : 12);
  const id = crypto.randomUUID();
  const expires = now + ttl;
  let verification, trialCode;
  if (phone) {
    await limit(env.DB, "sms:all", now, 30);
    const started = await verifyRequest(env, "Verifications", {
      To: phone,
      Channel: "sms",
    });
    if (
      started.status !== "pending" ||
      started.to !== phone ||
      started.channel !== "sms" ||
      started.service_sid !== env.TWILIO_VERIFY_SERVICE_SID ||
      !/^VE[0-9a-fA-F]{32}$/.test(started.sid)
    )
      fail(503, "SMSの送信を確認できませんでした。");
    verification = started.sid;
  } else {
    let n;
    do {
      [n] = crypto.getRandomValues(new Uint32Array(1));
    } while (n >= 4294000000);
    trialCode = String(n % 1000000).padStart(6, "0");
    verification = await mac(key, "code", id + ":" + trialCode);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires<=?").bind(now),
    env.DB.prepare("DELETE FROM issue_limits WHERE expires<=?").bind(now),
    env.DB.prepare(
      "INSERT INTO challenges(id,phone_key,action,code_mac,expires) VALUES(?,?,?,?,?)",
    ).bind(id, phoneKey, action, verification, expires),
  ]);
  return json({
    challengeId: id,
    expires,
    trialCode,
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
  const sms = env.AUTH_MODE === "sms";
  if (
    !c ||
    (!sms &&
      c.code_mac !== (await mac(key, "code", b.challengeId + ":" + b.code)))
  )
    denied();
  let profile, loginKey, legacy;
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
    const lookup = env.DB.prepare(
      "SELECT profile,login_key FROM wallets WHERE phone_key=?",
    );
    let stored = await lookup.bind(phoneKey).first();
    if (!stored && sms) {
      // A trial wallet can be adopted only with its original signer AND a live SMS.
      stored = await lookup.bind(await mac(key, "phone", b.phoneHash)).first();
      legacy = stored;
    }
    if (!stored) denied();
    await checkSignature(
      binary(stored.login_key, 32),
      b.proof,
      transcript(action, origin, b.phoneHash, b.challengeId),
    );
    profile = JSON.parse(stored.profile);
  }
  if (sms) {
    const checked = await verifyRequest(env, "VerificationCheck", {
      VerificationSid: c.code_mac,
      Code: b.code,
    });
    if (
      checked.status !== "approved" ||
      checked.sid !== c.code_mac ||
      checked.service_sid !== env.TWILIO_VERIFY_SERVICE_SID ||
      checked.channel !== "sms" ||
      typeof checked.to !== "string" ||
      (await phoneDigest(checked.to)) !== b.phoneHash
    )
      denied();
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
  if (legacy) {
    const adopted = await env.DB.prepare(
      "INSERT INTO wallets(phone_key,profile,login_key) VALUES(?,?,?) ON CONFLICT(phone_key) DO NOTHING",
    )
      .bind(phoneKey, legacy.profile, legacy.login_key)
      .run();
    if (adopted.meta.changes !== 1) denied();
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
        return json({
          service: "wara-auth",
          version: 2,
          mode:
            env.AUTH_MODE === "sms" && !smsReady(env)
              ? "disabled"
              : env.AUTH_MODE || "disabled",
        });
      const action = url.pathname.match(
        /^\/api\/auth\/(challenge|activate|signin)$/,
      )?.[1];
      if (!action) fail(404, "APIが見つかりません。");
      if (req.method !== "POST") fail(405, "POSTを使用してください。");
      const origin = req.headers.get("Origin");
      if (origin && origin !== url.origin)
        fail(403, "同じサイトから操作してください。");
      if (
        !["trial", "sms"].includes(env.AUTH_MODE) ||
        (env.AUTH_MODE === "sms" && !smsReady(env)) ||
        typeof env.AUTH_PEPPER !== "string" ||
        env.AUTH_PEPPER.length < 32 ||
        !env.DB
      )
        fail(503, "この環境の認証APIは準備中です。");
      const b = await bodyOf(req);
      fields(
        b,
        action === "challenge"
          ? [env.AUTH_MODE === "sms" ? "phone" : "phoneHash", "action"]
          : action === "activate"
            ? [...common, "profile", "loginKey", "walletProof"]
            : common,
      );
      if (action === "challenge" && env.AUTH_MODE === "sms") {
        if (typeof b.phone !== "string" || !/^\+[1-9]\d{7,14}$/.test(b.phone))
          bad();
        b.phoneHash = await phoneDigest(b.phone);
      }
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
      const phoneKey = await mac(
          key,
          env.AUTH_MODE === "sms" ? "sms-phone" : "phone",
          b.phoneHash,
        ),
        now = Math.floor(Date.now() / 1000);
      return action === "challenge"
        ? await issue(env, key, phoneKey, req, b.action, now, b.phone)
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
