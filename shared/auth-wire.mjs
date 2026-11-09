// Both signers and the Worker use the same ordered UTF-8 transcript.
const encoder = new TextEncoder();
export const toBase64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromBase64 = (str) =>
  Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
export async function phoneDigest(normalized) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode("wara.v03.phone\n" + normalized),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function transcript(
  action,
  origin,
  phoneHash,
  challengeId,
  profile,
  loginKey,
) {
  const fields = [
    "藁一本の約束 / WARA wallet login v1",
    origin,
    action,
    phoneHash,
    challengeId,
  ];
  if (action === "activate") {
    fields.push(
      profile.type,
      profile.address,
      loginKey,
      profile.vault?.salt ?? "",
      profile.vault?.iv ?? "",
      profile.vault?.ct ?? "",
    );
  }
  return encoder.encode(JSON.stringify(fields));
}
