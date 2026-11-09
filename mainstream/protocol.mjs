import { Buffer } from "buffer";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
export const pk = (x) => new PublicKey(x),
  sys = SystemProgram.programId,
  tok = TOKEN_PROGRAM_ID;
const key = (k, s = false, w = false) => ({
  pubkey: pk(k),
  isSigner: s,
  isWritable: w,
});
const actor = (x) => key(x, true, true),
  rw = (x) => key(x, false, true);
const data = (op, ...fields) =>
  Buffer.concat([Buffer.from([op]), ...fields.map((x) => Buffer.from(x))]);
const byte = (n) => Buffer.from([n]);
const ix = (program, keys, d) =>
  new TransactionInstruction({ programId: pk(program), keys, data: d });
export const addr = (p, tag, ...ids) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(tag), ...ids.map((id) => pk(id).toBuffer())],
    pk(p),
  )[0];
export const mintFor = (p, g) => addr(p, "w3", g);
export const ata = (mint, who) =>
  getAssociatedTokenAddressSync(pk(mint), pk(who));
const makeAta = (payer, mint, owner) =>
  createAssociatedTokenAccountIdempotentInstruction(
    pk(payer),
    ata(mint, owner),
    pk(owner),
    pk(mint),
  );
const budget = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 });
const u64 = (x) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(x));
  return b;
};
export const categories = ["地域", "学校", "サークル", "イベント"],
  modes = ["自由参加", "招待コード", "承認制"];
export function metadata(name, description, category) {
  name = String(name).trim();
  description = String(description).trim();
  const b = Buffer.from(JSON.stringify({ name, description, category }));
  if (
    !name ||
    name.length > 50 ||
    description.length > 140 ||
    b.length > 400 ||
    !categories.includes(category)
  )
    throw Error(
      "名称・説明・カテゴリを確認してください（合計400バイトまで）。",
    );
  return b;
}
export function createGroup(p, who, g, mode, inv, meta, rent) {
  if (!Number.isInteger(mode) || !modes[mode])
    throw Error("参加方式が不正です。");
  return [
    SystemProgram.createAccount({
      fromPubkey: pk(who),
      newAccountPubkey: pk(g),
      space: 66 + meta.length,
      lamports: rent,
      programId: pk(p),
    }),
    ix(
      p,
      [actor(who), actor(g), rw(mintFor(p, g)), key(sys), key(tok)],
      data(10, byte(mode), pk(inv).toBuffer(), meta),
    ),
  ];
}
export function certify(p, who, g, merchant, label) {
  const bytes = Buffer.from(label.trim());
  if (!bytes.length || bytes.length > 120)
    throw Error("店名は1〜120バイトで入力してください。");
  return ix(
    p,
    [
      actor(who),
      key(g),
      key(merchant),
      rw(addr(p, "s3", g, merchant)),
      key(sys),
    ],
    data(11, bytes),
  );
}
export function join(p, who, g, user, approve = false, invite = null) {
  return ix(
    p,
    [
      actor(who),
      key(g),
      key(user),
      rw(addr(p, "m3", g, user)),
      key(sys),
      ...(invite ? [key(invite, true)] : []),
    ],
    data(12, byte(approve ? 1 : 0)),
  );
}
export const offer = (p, who, g, peer, yes) =>
  ix(
    p,
    [actor(who), key(g), key(peer), rw(addr(p, "a3", g, peer)), key(sys)],
    data(13, byte(yes ? 1 : 0)),
  );
export function spend(p, who, g, merchant, n, day, nonce) {
  const m = mintFor(p, g);
  return [
    budget(),
    makeAta(who, m, merchant),
    makeAta(who, m, who),
    ix(
      p,
      [
        actor(who),
        key(g),
        key(merchant),
        key(addr(p, "s3", g, merchant)),
        key(addr(p, "m3", g, who)),
        rw(addr(p, "p3", who)),
        rw(m),
        rw(ata(m, merchant)),
        rw(ata(m, who)),
        key(sys),
        key(tok),
      ],
      data(14, u64(n), u64(day), u64(nonce)),
    ),
  ];
}
export function transfer(p, who, g, merchant, lots) {
  return [
    budget(),
    ...lots.flatMap(({ origin, amount }) => {
      const m = mintFor(p, origin);
      return [
        makeAta(who, m, merchant),
        ix(
          p,
          [
            actor(who),
            key(g),
            key(origin),
            key(merchant),
            key(addr(p, "s3", g, merchant)),
            ...(pk(g).equals(pk(origin))
              ? []
              : [key(addr(p, "a3", g, origin)), key(addr(p, "a3", origin, g))]),
            key(m),
            rw(ata(m, who)),
            rw(ata(m, merchant)),
            key(tok),
          ],
          data(15, u64(amount)),
        ),
      ];
    }),
  ];
}
export function split(lots, n) {
  if (n < 1n) throw Error("正の金額を指定してください。");
  const out = [];
  for (const l of lots) {
    if (l.amount <= 0n) continue;
    const used = l.amount < n ? l.amount : n;
    out.push({ ...l, amount: used });
    n -= used;
    if (!n) return out;
  }
  throw Error("この店で使えるWARAが不足しています。");
}
export function parseRow(raw, id) {
  const d = Buffer.from(raw),
    pub = (i) => pk(d.subarray(i, i + 32)).toBase58();
  if (d[0] === 31 && d.length > 66 && d.length <= 466 && d[33] <= 2) {
    let meta;
    try {
      meta = JSON.parse(d.subarray(66).toString());
    } catch {
      return null;
    }
    if (
      !meta ||
      typeof meta.name !== "string" ||
      typeof meta.description !== "string" ||
      !categories.includes(meta.category)
    )
      return null;
    return {
      tag: 31,
      id,
      owner: pub(1),
      mode: d[33],
      name: meta.name,
      description: meta.description,
      category: meta.category,
    };
  }
  if (d[0] === 32 && d.length > 65 && d.length <= 185)
    return {
      tag: 32,
      id,
      group: pub(1),
      to: pub(33),
      name: d.subarray(65).toString(),
    };
  if ([33, 34].includes(d[0]) && d.length === 66)
    return { tag: d[0], id, group: pub(1), to: pub(33), status: d[65] };
  return null;
}
export function quota(d, day) {
  if (!d) return { remaining: 10n, nonce: 0n };
  d = Buffer.from(d);
  if (d.length !== 25 || d[0] !== 35) throw Error("日次枠の形式が不正です。");
  const spent = d.readBigUInt64LE(9);
  if (spent > 10n || d.readBigInt64LE(1) > day)
    throw Error("日付・残高を再確認してください。");
  return {
    remaining: d.readBigInt64LE(1) === day ? 10n - spent : 10n,
    nonce: d.readBigUInt64LE(17),
  };
}
