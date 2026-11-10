import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { phoneDigest, transcript } from "../shared/auth-wire.mjs";
const prefix = "wara.v03.identity.",
  sessionKey = "wara.v03.active";
const enc = new TextEncoder();
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64 = (a) => btoa(String.fromCharCode(...new Uint8Array(a)));
const bytes = (s) => Uint8Array.from(atob(s), (x) => x.charCodeAt(0));

export function normalizePhone(s) {
  const n = String(s)
    .normalize("NFKC")
    .replace(/[ ()-]/g, "");
  const intl = n.startsWith("0") ? "+81" + n.slice(1) : n;
  if (!/^\+[1-9][0-9]{7,14}$/.test(intl))
    throw Error("国番号付き、または国内の電話番号を入力してください。");
  return intl;
}
async function phoneId(s) {
  let salt = localStorage.getItem(prefix + "salt");
  if (!salt) {
    salt = b64(random(24));
    localStorage.setItem(prefix + "salt", salt);
  }
  return b64(
    await crypto.subtle.digest("SHA-256", enc.encode(salt + normalizePhone(s))),
  );
}
export function challenge(now = Date.now()) {
  let n;
  do {
    [n] = crypto.getRandomValues(new Uint32Array(1));
  } while (n >= 4294000000);
  return {
    code: String(n % 1000000).padStart(6, "0"),
    expires: now + 300000,
    tries: 0,
    used: false,
  };
}
function checkLocalCode(c, code, now) {
  if (!c || c.used || now >= c.expires || c.tries >= 5)
    throw Error("確認コードを発行し直してください。");
  c.tries++;
  if (c.code !== code) throw Error("確認コードが違います。");
}
export function verify(c, code, now = Date.now()) {
  checkLocalCode(c, code, now);
  c.used = true;
}
async function wrapping(pass, salt) {
  if (pass.length < 8)
    throw Error("ウォレット用パスワードは8文字以上にしてください。");
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(pass),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function seal(pair, pass) {
  const salt = random(16),
    iv = random(12),
    key = await wrapping(pass, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    pair.secretKey,
  );
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
function phantom() {
  const p = globalThis.phantom?.solana;
  if (!p?.isPhantom) throw Error("Phantomをこのブラウザで開いてください。");
  return p;
}
export async function connectPhantom(address) {
  const p = phantom();
  const { publicKey } = await p.connect();
  if (address && publicKey.toBase58() !== address)
    throw Error("登録したPhantomアカウントを選んでください。");
  return p;
}
export async function openPair(profile, pass) {
  try {
    const { salt, iv, ct } = profile.vault;
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(iv) },
      await wrapping(pass, bytes(salt)),
      bytes(ct),
    );
    const k = Keypair.fromSecretKey(new Uint8Array(raw));
    if (k.publicKey.toBase58() !== profile.address) throw Error();
    return k;
  } catch {
    throw Error(
      "この端末のウォレットを開けません。パスワードを確認してください。",
    );
  }
}
export async function unlock(profile, pass) {
  if (profile.type === "phantom") return connectPhantom(profile.address);
  const pair = await openPair(profile, pass);
  return {
    publicKey: pair.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(pair);
      return tx;
    },
  };
}

async function api(path, payload) {
  const response = await fetch("/api/auth/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw Error("認証APIから応答がありません。再試行してください。");
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "認証を完了できませんでした。");
  return result;
}

export async function authMode() {
  const response = await fetch("/api/auth/status", {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (response.headers.get("X-Wara-Auth") === "1" && response.ok) {
    localStorage.setItem(prefix + "backend", "worker");
    const { mode = "trial", version } = await response.json();
    sessionStorage.setItem("wara.access.version",String(version ?? 2));
    if (mode === "trial" || mode === "sms" || mode === "google") return mode;
    throw Error("この環境の登録・サインインは準備中です。");
  }
  // Only a positively identified static host may create a device-local wallet.
  const staticHost = [
    "localhost",
    "127.0.0.1",
    "[::1]",
    "straw-promise-devnet.kentaroid.chatgpt.site",
  ].includes(location.hostname);
  if (
    staticHost &&
    !localStorage.getItem(prefix + "backend") &&
    (response.status === 404 ||
      response.status === 405 ||
      (response.ok &&
        response.headers.get("content-type")?.includes("text/html")))
  )
    return "local";
  throw Error("認証APIに接続できません。しばらくしてから再試行してください。");
}

export async function beginAuth(phone, action, expectedMode) {
  const phoneHash = await phoneDigest(normalizePhone(phone));
  const mode = await authMode();
  if (expectedMode && expectedMode !== mode)
    throw Error("認証方式が変わりました。ページを再読み込みしてください。");
  if (mode === "local")
    return { backend: "local", action, phoneHash, local: challenge() };
  const result = await api(
    "challenge",
    mode === "sms"
      ? { phone: normalizePhone(phone), action }
      : { phoneHash, action },
  );
  // Wrangler maps loopback requests to the configured route's host during development.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    location.hostname,
  );
  if (
    typeof result.audience !== "string" ||
    (!loopback && result.audience !== location.origin)
  )
    throw Error("認証先が一致しません。サイトのアドレスを確認してください。");
  return { backend: "worker", action, phoneHash, ...result };
}

export async function recoverySigner(pass, phoneHash) {
  if (pass.length < 8)
    throw Error("ウォレット用パスワードを8文字以上で入力してください。");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pass),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 600000,
        salt: enc.encode("wara.v03.auth-proof:" + phoneHash),
      },
      key,
      256,
    ),
  );
  return {
    publicKey: ed25519.getPublicKey(seed),
    sign: async (message) => b64(ed25519.sign(message, seed)),
  };
}
async function phantomSigner(address) {
  const provider = await connectPhantom(address);
  return {
    publicKey: provider.publicKey.toBytes(),
    sign: async (message) => {
      const signed = await provider.signMessage(message, "utf8");
      return b64(signed.signature);
    },
  };
}
async function makeProfile(type, pass) {
  if (!["embedded", "paper", "phantom"].includes(type))
    throw Error("ウォレットの種類を確認してください。");
  if (type === "phantom")
    return { type, address: (await connectPhantom()).publicKey.toBase58() };
  const pair = Keypair.generate();
  return {
    type,
    address: pair.publicKey.toBase58(),
    vault: await seal(pair, pass),
  };
}

async function registerRemote(profile, pass, proof, common) {
  let walletSigner, loginSigner;
  if (profile.type === "phantom") {
    walletSigner = loginSigner = await phantomSigner(profile.address);
  } else {
    const pair = await openPair(profile, pass);
    walletSigner = {
      sign: async (msg) =>
        b64(ed25519.sign(msg, pair.secretKey.subarray(0, 32))),
    };
    loginSigner = await recoverySigner(pass, proof.phoneHash);
  }
  const loginKey = b64(loginSigner.publicKey);
  const message = transcript(
    "activate",
    proof.audience,
    proof.phoneHash,
    proof.challengeId,
    profile,
    loginKey,
  );
  const walletProof = await walletSigner.sign(message);
  await api("activate", {
    ...common,
    profile,
    loginKey,
    walletProof,
    proof:
      loginSigner === walletSigner
        ? walletProof
        : await loginSigner.sign(message),
  });
}

export function hasDeviceWallet() {
  const accounts = prefix + "account.";
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(accounts) &&
        localStorage.getItem(prefix + "source." + key.slice(accounts.length)) === "device") return true;
  }
  return false;
}

export async function resolveWallet(phone, proof, code) {
  const id = await phoneId(phone);
  const local = JSON.parse(localStorage.getItem(prefix + "account." + id) || "null");
  let next;
  if (proof.backend === "local") {
    verify(proof.local, code);
    next = { action: local ? "signin" : "activate", type: local?.type, address: local?.address };
  } else {
    const credential = proof.firebase ? { idToken: await proof.confirmPhone(code) } : { code };
    next = await api("resolve", {
      phoneHash: proof.phoneHash, challengeId: proof.challengeId, action: proof.action, ...credential,
    });
  }
  return { ...proof, ...next, walletStep: true, deviceWallet: local && { type: local.type, address: local.address } };
}

export async function activate(phone, type, pass, proof, code) {
  if (!proof || proof.phoneHash !== (await phoneDigest(normalizePhone(phone))))
    throw Error("確認コードを発行し直してください。");
  const id = await phoneId(phone),
    key = prefix + "account." + id;
  const local = JSON.parse(localStorage.getItem(key) || "null");
  let profile = local;
  if (proof.backend === "local") {
    // Check the code now but consume it only when the local operation succeeds.
    if (!proof.walletStep) checkLocalCode(proof.local, code, Date.now());
    else if (!proof.local.used || Date.now() >= proof.local.expires) throw Error("確認コードを発行し直してください。");
    if (proof.action === "signin") {
      if (!local) throw Error("このブラウザに登録がありません。");
      await unlock(local, pass);
    } else {
      if (local)
        throw Error("この端末に登録済みです。サインインしてください。");
      profile = await makeProfile(type, pass);
    }
    proof.local.used = true;
  } else {
    const common = {
      phoneHash: proof.phoneHash,
      challengeId: proof.challengeId,
      ...(proof.walletStep ? { walletStep: true } : proof.firebase
        ? { idToken: await proof.confirmPhone(code) }
        : { code }),
    };
    if (proof.action === "activate") {
      if (proof.walletStep && proof.transfer && !local) throw Error("引き継ぐ財布がこの端末に見つかりません。");
      if (proof.walletStep && local && !proof.transfer) throw Error("この端末にある財布を引き継いでください。");
      profile = local || (await makeProfile(type, pass));
      await registerRemote(profile, pass, proof, common);
    } else {
      const signer =
        (proof.walletStep ? proof.type : local?.type ?? type) === "phantom"
          ? await phantomSigner(proof.walletStep ? proof.address : local?.address)
          : await recoverySigner(pass, proof.phoneHash);
      const message = transcript(
        "signin",
        proof.audience,
        proof.phoneHash,
        proof.challengeId,
      );
      ({ profile } = await api("signin", {
        ...common,
        proof: await signer.sign(message),
      }));
      if (local && local.address !== profile.address)
        throw Error(
          "この端末には別の財布があります。元の財布を保護するため、別のブラウザで復元してください。",
        );
      if (profile.type !== "phantom") await unlock(profile, pass);
    }
  }
  localStorage.setItem(key, JSON.stringify(profile));
  const source = proof.backend === "local" || proof.trialCode ? "device" : "registered";
  localStorage.setItem(prefix + "source." + id, source);
  sessionStorage.setItem(sessionKey, id);
  return profile;
}
export const mobileBrowser = () => navigator.maxTouchPoints > 0 || /Android|iPhone|iPad/i.test(navigator.userAgent);
export function rememberSession(result) {
  localStorage.removeItem("wara.phantom.signedout");
  // Use the server's remaining duration, even if the phone clock is ahead.
  const expires = Number.isFinite(result.remainingMs)
    ? Date.now() + Math.min(900000,result.remainingMs) : result.expires;
  sessionStorage.setItem("wara.member", JSON.stringify({...result,expires}));
  sessionStorage.removeItem(sessionKey);
}
export async function restorePhantom() {
  if (!mobileBrowser() || managedSession() || localStorage.getItem("wara.phantom.signedout")) return;
  const r=await fetch("/api/member/phantom-return",{method:"POST",credentials:"same-origin",redirect:"error",
    cache:"no-store",signal:AbortSignal.timeout(6000),headers:{"Content-Type":"application/json"},body:"{}"});
  if (r.ok && r.headers.get("X-Wara-Auth")==="1") {
    const result=await r.json();
    if (!localStorage.getItem("wara.phantom.signedout") && !managedSession()) rememberSession(result);
  }
}
export function managedSession() {
  const data=JSON.parse(sessionStorage.getItem("wara.member") || "null");
  if(data?.expires>Date.now() && !(data.profile?.type==="phantom" && localStorage.getItem("wara.phantom.signedout"))) return data;
  sessionStorage.removeItem("wara.member");
  return null;
}
export async function deviceProfile(phone) {
  return JSON.parse(localStorage.getItem(prefix+"account."+await phoneId(phone)) || "null");
}
export function active() {
  if(managedSession()) return managedSession().profile;
  const id = sessionStorage.getItem(sessionKey);
  if (!id) return null;
  try {
    const p = JSON.parse(localStorage.getItem(prefix + "account." + id));
    new PublicKey(p.address);
    return p;
  } catch {
    return null;
  }
}
export function signout() {
  const token=managedSession()?.session;
  localStorage.setItem("wara.phantom.signedout", "1");
  sessionStorage.removeItem("wara.member");
  if(token) void fetch("/api/member/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session:token}),keepalive:true}).catch(()=>{});
  sessionStorage.removeItem(sessionKey);
}
export const inviteSecret = () => bs58.encode(random(32));
