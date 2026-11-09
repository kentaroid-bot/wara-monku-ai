import test from "node:test";
import assert from "node:assert/strict";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import { Transaction, Keypair } from "@solana/web3.js";
import {
  metadata,
  createGroup,
  certify,
  join,
  offer,
  spend,
  transfer,
  split,
  addr,
  mintFor,
  ata,
  parseRow,
  quota,
} from "../mainstream/protocol.mjs";
import { normalizePhone, challenge, verify } from "../mainstream/identity.mjs";
test("phone challenge expires, locks after five guesses and can be consumed only once", () => {
  assert.equal(normalizePhone("０９０-００００-１２３４"), "+819000001234");
  assert.throws(() => normalizePhone("bad"));
  const c = challenge(100);
  assert.throws(() => verify(c, c.code, 300100));
  verify(c, c.code, 101);
  assert.throws(() => verify(c, c.code, 102));
  const d = challenge(100);
  for (let i = 0; i < 5; i++) assert.throws(() => verify(d, "", 101));
  assert.throws(() => verify(d, d.code, 102));
});
function world() {
  const svm = new LiteSVM(),
    p = Keypair.generate().publicKey;
  svm.addProgramFromFile(String(p), "target/deploy/straw_protocol.so");
  const users = Array.from({ length: 5 }, () => Keypair.generate());
  const [a, b, buyer, shop, third] = users;
  for (const k of users) svm.airdrop(String(k.publicKey), 5000000000n);
  const clock = svm.getClock();
  clock.unixTimestamp = 1700000000n;
  svm.setClock(clock);
  const send = (instructions, ...keys) => {
    svm.expireBlockhash();
    const t = new Transaction({
      feePayer: keys[0].publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(...instructions);
    t.sign(...keys);
    return svm.sendTransaction(getTransactionDecoder().decode(t.serialize()));
  };
  const ok = (r) =>
    assert(!(r instanceof FailedTransactionMetadata), r.toString());
  const no = (r) =>
    assert(r instanceof FailedTransactionMetadata, "expected rejection");
  const group = (owner, mode = 0, inv = owner) => {
    const g = Keypair.generate();
    const meta = metadata("町", "説明", "地域");
    ok(
      send(
        createGroup(
          p,
          owner.publicKey,
          g.publicKey,
          mode,
          inv.publicKey,
          meta,
          Number(svm.minimumBalanceForRentExemption(BigInt(66 + meta.length))),
        ),
        owner,
        g,
      ),
    );
    return g.publicKey;
  };
  const data = (k) => svm.getAccount(String(k))?.data;
  const day = () => (svm.getClock().unixTimestamp + 32400n) / 86400n;
  const wallet = () => quota(data(addr(p, "p3", buyer.publicKey)), day());
  const pay = (g, n, nonce = wallet().nonce, merchant = shop.publicKey) =>
    spend(p, buyer.publicKey, g, merchant, n, day(), nonce);
  const balance = (g, w) => {
    const raw = data(ata(mintFor(p, g), w.publicKey));
    return raw ? Buffer.from(raw).readBigUInt64LE(64) : 0n;
  };
  return {
    svm,
    p,
    a,
    b,
    buyer,
    shop,
    third,
    group,
    day,
    wallet,
    pay,
    balance,
    send,
    ok,
    no,
    data,
  };
}
test("v3 wallet has one JST limit across mints, signed purchases atomically issue 90:10 and preserve origin", () => {
  const {
    svm,
    p,
    a,
    b,
    buyer,
    shop,
    third,
    group,
    day,
    wallet,
    pay,
    balance,
    send,
    ok,
    no,
    data,
  } = world();
  const A = group(a),
    B = group(b);
  for (const [g, owner] of [
    [A, a],
    [B, b],
  ]) {
    ok(send([certify(p, owner.publicKey, g, shop.publicKey, "店")], owner));
    ok(send([join(p, buyer.publicKey, g, buyer.publicKey)], buyer));
  }
  assert.equal(parseRow(data(A), String(A)).owner, String(a.publicKey));
  assert.equal(wallet().remaining, 10n);
  ok(send(pay(A, 1), buyer));
  assert.equal(balance(A, shop), 90n);
  assert.equal(balance(A, buyer), 10n);
  no(send(pay(A, 1, 0n), buyer));
  no(send(pay(B, 1, 1n, third.publicKey), buyer));
  const bad = pay(A, 1);
  bad.at(-1).keys[8].pubkey = ata(mintFor(p, A), shop.publicKey);
  no(send(bad, buyer));
  assert.equal(wallet().remaining, 9n);
  ok(send(pay(B, 5), buyer));
  assert.equal(balance(B, shop), 450n);
  assert.equal(balance(B, buyer), 50n);
  no(send(pay(B, 5), buyer));
  ok(send(pay(A, 4), buyer));
  no(send(pay(B, 1), buyer));
  assert.equal(wallet().remaining, 0n);
  const prev = pay(A, 1);
  const c = svm.getClock();
  c.unixTimestamp = (day() + 1n) * 86400n - 32400n;
  svm.setClock(c);
  no(send(prev, buyer));
  assert.equal(wallet().remaining, 10n);
  ok(send(pay(A, 1), buyer));
  assert.equal(balance(A, buyer), 60n);
});
test("only founders certify / offer; invitations and approval are enforced; WARA transfer requires active mutual acceptance", () => {
  const {
    p,
    a,
    b,
    buyer,
    shop,
    third,
    group,
    pay,
    balance,
    send,
    ok,
    no,
    data,
  } = world();
  const inv = Keypair.generate(),
    A = group(a, 1, inv),
    B = group(b, 2);
  no(send([certify(p, buyer.publicKey, A, shop.publicKey, "spoof")], buyer));
  for (const [g, owner] of [
    [A, a],
    [B, b],
  ])
    ok(send([certify(p, owner.publicKey, g, shop.publicKey, "店")], owner));
  no(send(pay(A, 1), buyer));
  no(
    send(
      [join(p, buyer.publicKey, A, buyer.publicKey, false, third.publicKey)],
      buyer,
      third,
    ),
  );
  ok(
    send(
      [join(p, buyer.publicKey, A, buyer.publicKey, false, inv.publicKey)],
      buyer,
      inv,
    ),
  );
  ok(send(pay(A, 5), buyer));
  ok(send([join(p, buyer.publicKey, B, buyer.publicKey)], buyer));
  no(send(pay(B, 1), buyer));
  no(send([join(p, a.publicKey, B, buyer.publicKey, true)], a));
  ok(send([join(p, b.publicKey, B, buyer.publicKey, true)], b));
  ok(send(pay(B, 1), buyer));
  const x = () =>
    transfer(p, buyer.publicKey, B, shop.publicKey, [
      { origin: A, amount: 20n },
    ]);
  no(send(x(), buyer));
  no(send([offer(p, third.publicKey, B, A, true)], third));
  ok(send([offer(p, a.publicKey, A, B, true)], a));
  no(send(x(), buyer));
  ok(send([offer(p, b.publicKey, B, A, true)], b));
  ok(send(x(), buyer));
  assert.equal(balance(A, buyer), 30n);
  assert.equal(balance(A, shop), 470n);
  assert.equal(Buffer.from(data(mintFor(p, A))).readBigUInt64LE(36), 500n);
  ok(send([offer(p, b.publicKey, B, A, false)], b));
  no(send(x(), buyer));
  assert.equal(balance(A, buyer), 30n);
  assert.throws(() => split([{ origin: A, amount: 30n }], 31n));
});
