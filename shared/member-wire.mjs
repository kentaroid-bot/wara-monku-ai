export const questions = [
  "初めて登った山",
  "最初の遠足で行った場所",
  "初めて行った水族館",
  "生まれた病院",
  "子どもの頃の呼び名",
  "子どもの頃に好きだった食べ物",
];
export const normal = (value) =>
  typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, "").toLowerCase()
    : "";
export function walletMessage(origin, purpose, challenge, address) {
  return new TextEncoder().encode(
    JSON.stringify([
      "藁一本 / ウォレットの本人確認",
      origin,
      purpose,
      challenge,
      address,
    ]),
  );
}
