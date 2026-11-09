// Idempotent public Devnet fixtures. Dedicated test keys never leave private/.
import { SystemProgram } from "@solana/web3.js";
import { connection, payer, key, send } from "./devnet-common.mjs";
import {
  createGroup,
  certify,
  offer,
  metadata,
  addr,
} from "../mainstream/protocol.mjs";
import manifest from "../deployments/devnet.json" with { type: "json" };
const p = manifest.program,
  funder = await payer();
const accounts = await Promise.all(
  ["region-a", "region-b", "store-a", "store-b", "issuer-a", "issuer-b"].map(
    (s) => key("v03-fixture-" + s),
  ),
);
const [a, b, m, n, A, B] = accounts;
for (const admin of [a, b])
  if ((await connection.getBalance(admin.publicKey)) < 10000000)
    await send(
      [
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: admin.publicKey,
          lamports: 45000000,
        }),
      ],
      [funder],
    );
for (const [admin, group, store, name, label] of [
  [a, A, m, "みどり商店街", "みどりカフェ"],
  [b, B, n, "川辺の市場", "川辺の食堂"],
]) {
  if (!(await connection.getAccountInfo(group.publicKey))) {
    const info = metadata(
      name,
      "Devnetで支払いを試せる、自由参加の体験地域です。",
      "地域",
    );
    console.log(
      "group",
      await send(
        createGroup(
          p,
          admin.publicKey,
          group.publicKey,
          0,
          admin.publicKey,
          info,
          await connection.getMinimumBalanceForRentExemption(66 + info.length),
        ),
        [admin, group],
      ),
    );
  }
  if (
    !(await connection.getAccountInfo(
      addr(p, "s3", group.publicKey, store.publicKey),
    ))
  )
    console.log(
      "store",
      await send(
        [certify(p, admin.publicKey, group.publicKey, store.publicKey, label)],
        [admin],
      ),
    );
}
for (const [owner, from, to] of [
  [a, A, B],
  [b, B, A],
])
  if (
    !(await connection.getAccountInfo(
      addr(p, "a3", from.publicKey, to.publicKey),
    ))
  )
    console.log(
      "alliance",
      await send(
        [offer(p, owner.publicKey, from.publicKey, to.publicKey, true)],
        [owner],
      ),
    );
console.log(
  "Open community:",
  String(A.publicKey),
  "store:",
  String(m.publicKey),
  "allied community:",
  String(B.publicKey),
);
