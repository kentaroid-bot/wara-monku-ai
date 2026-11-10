import test from "node:test";
import assert from "node:assert/strict";
import { active, managedSession, rememberSession, signout } from "../mainstream/identity.mjs";

function makeStorage() {
  const items = new Map();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key),
    clear: () => items.clear(),
  };
}

function setup(t) {
  for (const key of ["localStorage", "sessionStorage"]) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: makeStorage() });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
}

const week = 604800000;
const member = { session: "ticket", profile: { managed: true, address: "test-address", type: "embedded" } };

test("reopening the wallet preserves the seven-day deadline and expires at its boundary", t => {
  setup(t);
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  rememberSession({ ...member, remainingMs: week + 1 });
  const deadline = now + week;
  assert.equal(sessionStorage.getItem("wara.member"), null);
  sessionStorage.clear();
  now = deadline - 1;
  assert.deepEqual(active(), member.profile);
  assert.equal(managedSession().expires, deadline);
  now = deadline;
  assert.equal(active(), null);
  assert.equal(localStorage.getItem("wara.member"), null);
});

test("old tab tickets migrate with their own expiry and cannot restore a signed-out wallet", t => {
  setup(t);
  const old = { ...member, expires: Date.now() + 60000 };
  sessionStorage.setItem("wara.member", JSON.stringify(old));
  assert.deepEqual(managedSession(), old);
  assert.equal(sessionStorage.getItem("wara.member"), null);
  assert.deepEqual(JSON.parse(localStorage.getItem("wara.member")), old);

  rememberSession({ ...member, session: "new-ticket", remainingMs: week });
  sessionStorage.setItem("wara.member", JSON.stringify(old));
  const revoke = t.mock.method(globalThis, "fetch", async () => new Response());
  signout();
  assert.deepEqual(JSON.parse(revoke.mock.calls[0].arguments[1].body), {session: "new-ticket"});
  assert.equal(localStorage.getItem("wara.member"), null);
  assert.equal(sessionStorage.getItem("wara.member"), null);
  sessionStorage.setItem("wara.member", JSON.stringify(old)); // Another pre-upgrade tab.
  assert.equal(active(), null);
  assert.equal(sessionStorage.getItem("wara.member"), null);
});
