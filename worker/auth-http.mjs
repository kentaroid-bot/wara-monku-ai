import securityHeaders from "../shared/security-headers.cjs";
import { Failure } from "./failure.mjs";

export const fail = (status, text) => {
  throw new Failure(status, text);
};
export const denied = () =>
  fail(
    401,
    "確認情報を照合できません。確認コードとサインイン方法を確認してください。",
  );
export const bad = () => fail(400, "リクエストの形式を確認してください。");
export function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Wara-Auth": "1",
      ...securityHeaders,
    },
  });
}
export function fields(value, names) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !names.includes(k)) ||
    names.some((k) => !Object.hasOwn(value, k))
  )
    bad();
}
export async function bodyOf(req, maxBody) {
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
