import securityHeaders from "../shared/security-headers.cjs";
import { Failure } from "./failure.mjs";
import { communityMetadata } from "./community-metadata.mjs";
import { feeKey } from "./relay.mjs";
import { verifiedPhoneEvent } from "./google-phone.mjs";
import { memberRequest } from "./members.mjs";
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
      ...securityHeaders,
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
async function bodyOf(req, maxBody) {
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
function googleConfig(env) {
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.FIREBASE_PROJECT_ID ?? "") ||
    !env.FIREBASE_WEB_API_KEY ||
    !env.FIREBASE_APP_ID
  )
    return null;
  return {
    projectId: env.FIREBASE_PROJECT_ID,
    appId: env.FIREBASE_APP_ID,
    apiKey: env.FIREBASE_WEB_API_KEY,
    authDomain: env.FIREBASE_PROJECT_ID + ".firebaseapp.com",
  };
}
async function limitGoogleChallenge(db, ipKey, phoneKey, now) {
  // Each expiry is the time the bucket will be full again. Reserve one slot
  // from every bucket in the same transaction, or leave all three untouched.
  const buckets = `WITH limits(bucket, capacity, seconds) AS (VALUES
    (?1, 20, 10), (?2, 5, 60), ('google-issue:all', 30, 30)
  ), slots AS (
    SELECT bucket, seconds, MAX(?3, COALESCE(expires, ?3)) AS full_at, capacity
    FROM limits LEFT JOIN issue_limits USING (bucket)
  )`;
  const wait = "SELECT MAX(0, MAX(full_at - (capacity - 1) * seconds - ?3)) FROM slots";
  const bind = (sql) => db.prepare(buckets + sql)
    .bind("google-issue:ip:" + ipKey, "google-issue:phone:" + phoneKey, now);
  const [check] = await db.batch([
    bind(`SELECT (${wait}) AS wait_seconds`),
    bind(`INSERT INTO issue_limits(bucket, expires, count)
      SELECT bucket, full_at + seconds, 1 FROM slots WHERE (${wait}) = 0
      ON CONFLICT(bucket) DO UPDATE SET expires = excluded.expires`),
  ]);
  const retry = check.results[0].wait_seconds;
  if (retry > 0) fail(429, `確認のリクエストが続いています。${retry}秒後にお試しください。`);
}
async function issue(env, key, phoneKey, req, action, now, phone) {
  if (!["activate", "signin"].includes(action)) bad();
  const google = env.AUTH_MODE === "google";
  const ipKey = await mac(key, "ip", req.headers.get("CF-Connecting-IP") || "local");
  if (google) {
    await limitGoogleChallenge(env.DB, ipKey, phoneKey, now);
  } else {
    await limit(env.DB, "ip:" + ipKey, now, phone ? 10 : 60);
    await limit(env.DB, "phone:" + phoneKey, now, phone ? 3 : 12);
    if (phone) await limit(env.DB, "sms:all", now, 30);
  }
  const id = crypto.randomUUID();
  const expires = now + ttl;
  let verification, trialCode;
  if (google) {
    verification = "google";
  } else if (phone) {
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
    ...(google ? { firebase: googleConfig(env) } : {}),
    challengeId: id,
    expires,
    trialCode,
    audience: new URL(req.url).origin,
  });
}
async function reserveAttempt(env, key, action, b, phoneKey, now) {
  if (!["activate", "signin"].includes(action) ||
      typeof b.challengeId !== "string" || !/^[0-9a-f-]{36}$/.test(b.challengeId)) bad();
  const c = await env.DB.prepare(
    `UPDATE challenges SET attempts=attempts+1
     WHERE id=? AND phone_key=? AND action=? AND expires>? AND attempts<5 RETURNING code_mac,expires`,
  ).bind(b.challengeId, phoneKey, action, now).first();
  if (!c) denied();
  if (b.walletStep === true) {
    if (c.code_mac !== "verified:" + env.AUTH_MODE) denied();
    return c;
  }
  if (env.AUTH_MODE === "google") {
    if (typeof b.idToken !== "string" || c.code_mac !== "google") denied();
  } else {
    if (typeof b.code !== "string" || !/^\d{6}$/.test(b.code)) bad();
    if (env.AUTH_MODE === "sms" ? !/^VE[0-9a-fA-F]{32}$/.test(c.code_mac)
      : c.code_mac !== await mac(key, "code", b.challengeId + ":" + b.code)) denied();
  }
  return c;
}

async function verifyDelivery(env, b, c, phoneKey, now) {
  if (env.AUTH_MODE === "sms") {
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
  if (env.AUTH_MODE === "google") {
    const event = await verifiedPhoneEvent(
      b.idToken,
      env.FIREBASE_PROJECT_ID,
      b.phoneHash,
      c.expires - ttl,
      now,
    );
    if (!event) denied();
    const used = await env.DB.prepare(
      "INSERT INTO issue_limits(bucket,expires,count) VALUES(?,?,1) ON CONFLICT(bucket) DO NOTHING",
    )
      .bind("google-auth:" + phoneKey + ":" + event, now + windowSeconds)
      .run();
    if (used.meta.changes !== 1) denied();
  }
}

async function findWallet(env, key, phoneKey, phoneHash, allowTrial) {
  const lookup = env.DB.prepare("SELECT profile,login_key FROM wallets WHERE phone_key=?");
  const stored = await lookup.bind(phoneKey).first();
  if (stored || !allowTrial || env.AUTH_MODE === "trial") return stored;
  const legacy = await lookup.bind(await mac(key, "phone", phoneHash)).first();
  return legacy && legacy.login_key !== "managed" ? { ...legacy, legacy: true } : null;
}

async function resolveWallet(env, key, b, phoneKey, now) {
  const c = await reserveAttempt(env, key, b.action, b, phoneKey, now);
  await verifyDelivery(env, b, c, phoneKey, now);
  const stored = await findWallet(env, key, phoneKey, b.phoneHash, b.action === "signin");
  const action = stored ? "signin" : "activate";
  // Rotate the public SMS challenge to a private, one-use wallet challenge.
  const challengeId = crypto.randomUUID();
  const current = Math.floor(Date.now() / 1000);
  const changed = await env.DB.prepare(
    `UPDATE challenges SET id=?, action=?, code_mac=?, expires=?, attempts=0
     WHERE id=? AND phone_key=? AND action=? AND code_mac=? AND expires>?`,
  ).bind(challengeId, action, "verified:" + env.AUTH_MODE, current + ttl,
    b.challengeId, phoneKey, b.action, c.code_mac, current).run();
  if (changed.meta.changes !== 1) denied();
  const profile = stored && JSON.parse(stored.profile);
  return json({ action, challengeId, type: profile?.type ?? null,
    ...(stored?.login_key === "managed" ? {managed:true} : {}),
    address: profile?.type === "phantom" ? profile.address : null });
}

async function redeem(env, key, origin, action, b, phoneKey, now) {
  const c = await reserveAttempt(env, key, action, b, phoneKey, now);
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
    const stored = await findWallet(env, key, phoneKey, b.phoneHash, true);
    legacy = stored?.legacy && stored;
    if (!stored) denied();
    await checkSignature(
      binary(stored.login_key, 32),
      b.proof,
      transcript(action, origin, b.phoneHash, b.challengeId),
    );
    profile = JSON.parse(stored.profile);
  }
  if (b.walletStep !== true) await verifyDelivery(env, b, c, phoneKey, now);
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

export default {
  async fetch(req, env, context) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/v3/metadata/")) return communityMetadata(req, env, context);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      const google = env.AUTH_MODE === "google";
      if (url.pathname === "/api/auth/status" && req.method === "GET")
        return json({
          service: "wara-auth",
          version: env.WALLET_ACCESS === "enabled" ? 3 : 2,
          mode:
            (env.AUTH_MODE === "sms" && !smsReady(env)) ||
            (google && !googleConfig(env))
              ? "disabled"
              : env.AUTH_MODE || "disabled",
        });
      if (url.pathname === "/api/fee-payer" && req.method === "GET")
        return json({feePayerPubkey: env.WALLET_ACCESS === "enabled" && ["trial","sms","google"].includes(env.AUTH_MODE)
          ? feeKey(env)?.publicKey.toBase58() ?? null : null});
      const relayOp = {"/api/relay":"relay", "/api/relay/status":"relay-status"}[url.pathname];
      const action = url.pathname.match(
        /^\/api\/auth\/(challenge|resolve|activate|signin)$/,
      )?.[1];
      const queue = url.pathname === "/api/v3/shop-requests";
      const memberOp = env.WALLET_ACCESS === "enabled" && ((queue && "shopRequests") || relayOp || url.pathname.match(/^\/api\/member\/([a-z-]+)$/)?.[1]);
      if (!action && !memberOp) fail(404, "APIが見つかりません。");
      if (queue ? !["GET","POST","DELETE"].includes(req.method) : req.method !== "POST")
        fail(405, "この操作方法には対応していません。");
      const origin = req.headers.get("Origin");
      if (origin && origin !== url.origin)
        fail(403, "同じサイトから操作してください。");
      if (
        !["trial", "sms", "google"].includes(env.AUTH_MODE) ||
        (google && !googleConfig(env)) ||
        (env.AUTH_MODE === "sms" && !smsReady(env)) ||
        typeof env.AUTH_PEPPER !== "string" ||
        env.AUTH_PEPPER.length < 32 ||
        !env.DB
      )
        fail(503, "この環境の認証APIは準備中です。");
      const b = queue && req.method === "GET"
        ? {group:url.searchParams.get("group"), after:url.searchParams.get("after"), merchant:url.searchParams.get("merchant")}
        : await bodyOf(req, google ? 8192 : maxBody);
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(env.AUTH_PEPPER),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      if (memberOp) {
        const ctx = {env, req, origin:url.origin, key, now:Math.floor(Date.now()/1000), mac, limit, fail, denied, bad, checkSignature};
        if(memberOp === "legacy-vault") {
          if(typeof b.phoneHash!=="string" || !/^[a-f0-9]{64}$/.test(b.phoneHash)) bad();
          const phone=await mac(key,env.AUTH_MODE==="trial"?"phone":"sms-phone",b.phoneHash);
          await reserveAttempt(env,key,"signin",{...b,walletStep:true},phone,ctx.now);
          const stored=await findWallet(env,key,phone,b.phoneHash,true);
          if(!stored || stored.login_key==="managed") denied();
          await checkSignature(binary(stored.login_key,32),b.proof,transcript("signin",url.origin,b.phoneHash,b.challengeId));
          return json({profile:JSON.parse(stored.profile)});
        }
        const cookieName = "__Host-wara-phantom";
        const returnToken = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)__Host-wara-phantom=([1-9A-HJ-NP-Za-km-z]{32,44})(?:;|$)/)?.[1];
        if (memberOp === "phantom-return" && !returnToken) denied();
        const result = await memberRequest(memberOp,b,{...ctx,returnToken});
        const response = json(result);
        const setReturn = token => response.headers.append("Set-Cookie",
          cookieName+"="+token+"; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age="+(token ? 900 : 0));
        if (memberOp !== "phantom-return" && result.session) {
          if (result.profile.type === "phantom" && b.mobileReturn === true) setReturn(result.session);
          else if (returnToken) setReturn("");
        } else if (memberOp === "logout" && returnToken && returnToken === b.session) setReturn("");
        return response;
      }
      if(env.WALLET_ACCESS==="enabled" && ["activate","signin"].includes(action))
        fail(409,"画面を再読み込みし、財布の暗証番号を使う手続きに進んでください。");
      const credential = google ? "idToken" : "code";
      const common = ["phoneHash", "challengeId", b?.walletStep === true ? "walletStep" : credential, "proof"];
      fields(
        b,
        action === "challenge"
          ? [env.AUTH_MODE === "sms" ? "phone" : "phoneHash", "action"]
          : action === "resolve" ? ["phoneHash", "challengeId", "action", credential]
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
      const phoneKey = await mac(
          key,
          env.AUTH_MODE !== "trial" ? "sms-phone" : "phone",
          b.phoneHash,
        ),
        now = Math.floor(Date.now() / 1000);
      if (action === "resolve") return await resolveWallet(env, key, b, phoneKey, now);
      return action === "challenge"
        ? await issue(env, key, phoneKey, req, b.action, now, b.phone)
        : await redeem(env, key, url.origin, action, b, phoneKey, now);
    } catch (e) {
      if (!(e instanceof Failure)) {
        console.error("Worker unhandled error:", e?.stack || e);
      }
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
