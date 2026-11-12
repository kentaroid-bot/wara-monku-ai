import { Failure } from "./failure.mjs";
import { communityMetadata } from "./community-metadata.mjs";
import { feeKey } from "./relay.mjs";
import { json, bodyOf, fail } from "./auth-http.mjs";
import { smsReady, googleConfig, authFlow, memberFlow } from "./auth-flows.mjs";

const enc = new TextEncoder();
const maxBody = 4096;

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
      if (memberOp) return await memberFlow(memberOp, b, env, req, key, url.origin);
      return await authFlow(action, b, env, req, key, url.origin);
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
