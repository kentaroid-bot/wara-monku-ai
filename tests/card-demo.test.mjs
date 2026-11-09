import test from "node:test";
import assert from "node:assert/strict";
import { fresh, transition, balances, cardPayload } from "../card-demo/model.mjs";
const start = (s = fresh(), amount = 1, id = "one", communityId = "midori-shoptown") =>
  transition(s, { type: "checkout", amount, id, communityId });
const join = (s) => transition(s, { type: "joinCommunity", code: "WASEDA2026" });
const pay = (s, id = "one") =>
  transition(s, {
    type: "pay",
    pin: "123456",
    id,
    time: "2026-11-08T04:00:00Z",
  });
for (const [amount, shopCredit, userRefund] of [[1, 90, 10], [5, 450, 50]]) {
  test(`${amount} Kusa pays ${shopCredit} to shop and refunds ${userRefund} with the same origin`, () => {
    const pending = start(join(fresh()), amount, "one", "waseda-univ");
    assert.equal(pending.spent, 0);
    assert.deepEqual(balances(pending.history), { shopWara: 0, userWara: 0 });
    const paid = pay(pending);
    assert.equal(paid.spent, amount);
    assert.equal(paid.pending, null);
    assert.equal(paid.history.length, 1);
    const receipt = paid.history[0];
    assert.equal(receipt.communityId, "waseda-univ");
    assert.equal(receipt.remaining, 10 - amount);
    assert.deepEqual(balances(paid.history), { shopWara: shopCredit, userWara: userRefund });
    assert.throws(() => pay(paid));
    assert.throws(() => start(paid, 1, "one"));
  });
}
test("wrong demo PIN never spends; three attempts require the support path", () => {
  let s = start();
  for (let i = 0; i < 3; i++)
    s = transition(s, { type: "pay", pin: "999999", id: "one" });
  assert.equal(s.spent, 0);
  assert.deepEqual(balances(s.history), { shopWara: 0, userWara: 0 });
  assert.throws(() => pay(s));
  s = transition(s, { type: "requestSupport" });
  assert.throws(() =>
    transition(s, { type: "approve", id: "one", consent: false }),
  );
  s = transition(s, { type: "approve", id: "one", consent: true, time: "now" });
  assert.equal(s.spent, 1);
  assert.deepEqual(balances(s.history), { shopWara: 90, userWara: 10 });
  assert.equal(s.history[0].method, "support");
});
test("support cannot approve a normal checkout or an obsolete invoice", () => {
  const s = start();
  assert.throws(() =>
    transition(s, { type: "approve", id: "one", consent: true }),
  );
  const waiting = transition(s, { type: "requestSupport" });
  assert.throws(() => pay(waiting));
  assert.throws(() =>
    transition(waiting, { type: "approve", id: "old", consent: true }),
  );
  const canceled = transition(waiting, { type: "cancel" });
  assert.equal(canceled.spent, 0);
  assert.throws(() =>
    transition(canceled, { type: "approve", id: "one", consent: true }),
  );
});
test("ten Kusa shared across communities, next day renews only the quota", () => {
  for (const amount of [0, -1, 1.5, 11, NaN])
    assert.throws(() => start(fresh(), amount));
  assert.throws(() => start(fresh(), 1, "one", "unknown"));
  let s = join(pay(start(fresh(), 5)));
  assert.throws(() => start(s, 6, "two", "waseda-univ"));
  s = pay(start(s, 5, "two", "waseda-univ"), "two");
  assert.equal(s.spent, 10);
  assert.throws(() => start(s, 1, "three"));
  s = transition(s, { type: "nextDay" });
  assert.equal(s.spent, 0);
  assert.deepEqual(balances(s.history), { shopWara: 900, userWara: 100 });
  assert.deepEqual(s.history.map(h => h.communityId), ["waseda-univ", "midori-shoptown"]);
  s = pay(start(s, 10, "three"), "three");
  assert.deepEqual(balances(s.history), { shopWara: 1800, userWara: 200 });
});
test("stopping/reissuing a card and changing day cancel pending payments without restoring used allowance", () => {
  let s = start(pay(start()), 1, "two");
  s = transition(s, { type: "stop" });
  assert.equal(s.pending, null);
  assert.throws(() => start(s, 1, "three"));
  s = transition(s, { type: "reissue" });
  assert.equal(s.spent, 1);
  assert.equal(s.cardVersion, 2);
  assert.throws(() => pay(s, "two"));
  s = start(s, 1, "three");
  s = transition(s, { type: "nextDay" });
  assert.equal(s.pending, null);
  assert.throws(() => pay(s, "three"));
  assert.deepEqual(balances(s.history), { shopWara: 90, userWara: 10 });
});

test("invite code admits only the new community and leaves used quota intact", () => {
  const s = pay(start());
  assert.throws(() => start(s, 1, "two", "waseda-univ"));
  assert.throws(() => transition(s, {type: "joinCommunity", code: "__proto__"}));
  const member = join(s);
  assert.deepEqual(member.communities, ["midori-shoptown", "waseda-univ"]);
  assert.throws(() => join(member));
  const paid = pay(start(member, 5, "two", "waseda-univ"), "two");
  assert.equal(paid.spent, 6);
  assert.equal(balances(paid.history.filter(h => h.communityId === "waseda-univ")).userWara, 50);
});

test("wallet switch preserves credits, membership and usage", () => {
  const s = pay(start(join(fresh())));
  const phantom = transition(s, { type: "setWallet", walletType: "phantom" });
  assert.deepEqual(phantom, { ...s, walletType: "phantom" });
  assert.deepEqual(transition(phantom, {type: "setWallet", walletType: "embedded"}), s);
  assert.throws(() => transition(s, {type: "setWallet", walletType: "bad"}));
});

test("scanned cards must match this participant, card version and active status", () => {
  const s = fresh(), card = cardPayload(s);
  const scan = (state, payload) => transition(state, {
    type: "checkout", amount: 1, communityId: "midori-shoptown", id: "scan", card: payload
  });
  assert.equal(scan(s, card).pending.status, "confirm");
  for (const invalid of ["not-json", "null", card.replace("C-001", "C-002"), card.replace("wara-card-ui-demo", "other")])
    assert.throws(() => scan(s, invalid));
  assert.throws(() => scan(transition(s, {type: "stop"}), card));
  const reissued = transition(s, {type: "reissue"});
  assert.throws(() => scan(reissued, card));
  assert.equal(scan(reissued, cardPayload(reissued)).spent, 0);
});

const midori = "midori-shoptown", waseda = "waseda-univ";
const alliance = (s, from, to, decision) =>
  transition(s, {type: "setAlliance", communityId: from, peerId: to, decision});
const spendWara = (s, amount, id, communityId, shopId = "S-001") =>
  transition(s, {type: "payWara", amount, id, communityId, shopId, time: "12:00"});

test("a newly created community can certify its own shops and use their registers", () => {
  const action = {type: "createCommunity", communityId: "north", name: "北町", category: "地域", description: "北町商店会"};
  const s = transition(fresh(), action);
  assert.throws(() => transition(s, action));
  assert.throws(() => transition(s, {...action, communityId: '<script>'}));
  assert.throws(() => start(s, 1, "one", "north"));
  const approved = transition(s, {type: "addShop", communityId: "north", name: "北町カフェ"});
  assert.throws(() => transition(approved, {type:"addShop", communityId:"north", name:"北町カフェ"}));
  assert.equal(pay(start(approved, 1, "one", "north")).history[0].shopId, "S-001");
});

test("both parties must agree; transferred WARA keeps its origin through cancellation and rollover", () => {
  const s = pay(start(fresh(), 5));
  assert.throws(() => spendWara(s, 25, "two", waseda), /未提携/);
  const requested = alliance(s, midori, waseda, "request");
  assert.throws(() => spendWara(requested, 25, "two", waseda));
  assert.throws(() => alliance(requested, midori, waseda, "accept"));
  const linked = alliance(requested, waseda, midori, "accept");
  assert.throws(() => spendWara(linked, 25, "two", waseda, "unapproved"));
  const paid = spendWara(linked, 25, "two", waseda);
  assert.equal(paid.spent, 5);
  assert.equal(paid.history.length, 1);
  assert.deepEqual(paid.transfers[0].origins, [{id:midori, amount:25}]);
  assert.throws(() => spendWara(paid, 5, "two", waseda));
  assert.throws(() => spendWara(paid, 26, "three", waseda));
  const removed = alliance(transition(paid, {type:"nextDay"}), midori, waseda, "remove");
  assert.throws(() => spendWara(removed, 1, "three", waseda));
  assert.deepEqual(spendWara(removed, 25, "three", midori).transfers[0].origins, [{id:midori, amount:25}]);
});

test("mixed-origin payment debits accepted funds at face value without minting", () => {
  let s = pay(start(join(fresh()), 1));
  s = pay(start(s, 2, "two", waseda), "two");
  s = alliance(alliance(s, waseda, midori, "request"), midori, waseda, "accept");
  const paid = spendWara(s, 25, "three", midori);
  assert.deepEqual(paid.transfers[0].origins, [{id:midori,amount:10}, {id:waseda,amount:15}]);
  assert.deepEqual(paid.history, s.history);
  assert.equal(paid.spent, s.spent);
  assert.throws(() => spendWara(paid, 6, "four", midori));
});
