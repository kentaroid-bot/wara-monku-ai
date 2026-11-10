import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import {
  Transaction,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import { program, rpc, submit, checkPending } from "../mainstream/network.mjs";
import {
  createGroup,
  certify,
  join,
  spend,
  transfer,
  ata,
  mintFor,
  metadata,
} from "../mainstream/protocol.mjs";
import { DEVNET_GENESIS, budgetInstructions } from "../app/protocol.mjs";
import { sponsoredInstructions } from "../shared/sponsorship.mjs";
import { relayPayment } from "../worker/relay.mjs";

const key = () => Keypair.generate();
const wire = (tx) =>
  tx.serialize({ requireAllSignatures: false }).toString("base64");

test("signed-in zero-SOL buyer joins, spends and transfers through Worker/D1 and the deployed program binary", async (t) => {
  const svm = new LiteSVM();
  svm.addProgramFromFile(String(program), "target/deploy/straw_protocol.so");
  const sponsor = key(),
    owner = key(),
    group = key(),
    shop = key(),
    buyer = key(),
    invite = key();
  const g = group.publicKey,
    user = buyer.publicKey,
    merchant = shop.publicKey,
    secondShop = key().publicKey;
  svm.airdrop(String(sponsor.publicKey), 2_000_000_000n);
  svm.airdrop(String(owner.publicKey), 2_000_000_000n);
  function execute(raw) {
    const result = svm.sendTransaction(getTransactionDecoder().decode(raw));
    assert(!(result instanceof FailedTransactionMetadata), result.toString());
  }
  function admin(ix, ...keys) {
    const tx = new Transaction({
      feePayer: owner.publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(...ix);
    tx.sign(owner, ...keys);
    execute(tx.serialize());
  }
  const meta = metadata("市場", "", "地域");
  admin(
    createGroup(
      program,
      owner.publicKey,
      g,
      1,
      invite.publicKey,
      meta,
      Number(svm.minimumBalanceForRentExemption(BigInt(66 + meta.length))),
    ),
    group,
  );
  admin([certify(program, owner.publicKey, g, merchant, "店舗")]);
  admin([certify(program, owner.publicKey, g, secondShop, "別の店舗")]);
  const minRent = (n) => Number(svm.minimumBalanceForRentExemption(BigInt(n)));
  const account = (pub) => {
    const a = svm.getAccount(String(pub));
    return a.exists
      ? {
          owner: new PublicKey(a.programAddress),
          data: Buffer.from(a.data),
          lamports: Number(a.lamports),
        }
      : null;
  };
  const broadcast = [];
  let rateLimitedWire;
  async function rpcRequest(req) {
    const { id, method, params } = await req.json();
    const ctx = (value) => ({ context: { slot: 1 }, value });
    let result;
    switch (method) {
      case "getGenesisHash":
        result = DEVNET_GENESIS;
        break;
      case "isBlockhashValid":
        result = ctx(params[0] === svm.latestBlockhash());
        break;
      case "getMinimumBalanceForRentExemption":
        result = minRent(params[0]);
        break;
      case "getAccountInfo": {
        const a = account(params[0]);
        result = ctx(
          a && {
            ...a,
            owner: String(a.owner),
            executable: false,
            rentEpoch: 0,
            data: [a.data.toString("base64"), "base64"],
          },
        );
        break;
      }
      case "simulateTransaction": {
        assert.equal(params[1].sigVerify, true);
        const sim = svm.simulateTransaction(
          getTransactionDecoder().decode(Buffer.from(params[0], "base64")),
        );
        result = ctx({
          err:
            sim instanceof FailedTransactionMetadata
              ? "InvalidAccountData"
              : null,
          logs: [],
        });
        break;
      }
      case "sendTransaction": {
        if (!rateLimitedWire) {
          rateLimitedWire = params[0];
          return new Response("rate limited", {status:429, headers:{"Retry-After":"1"}});
        }
        if (!broadcast.length) assert.equal(params[0], rateLimitedWire);
        const raw = Buffer.from(params[0], "base64");
        execute(raw);
        result = bs58.encode(Transaction.from(raw).signature);
        broadcast.push(result);
        break;
      }
      default:
        throw Error("Unexpected RPC: " + method);
    }
    return Response.json({ id, jsonrpc: "2.0", result });
  }
  const code = (
    await build({
      entryPoints: ["worker/index.mjs"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    })
  ).outputFiles[0].text;
  const pepper = randomBytes(32).toString("hex"),
    session = bs58.encode(randomBytes(32));
  const text = (value) => ({ type: "text", value });
  const runtime = new Miniflare({
    enableDevRegistry: false,
    workers: [
      {
        config: {
          name: "relay-test",
          compatibilityDate: "2026-11-04",
          manifest: {
            mainModule: "index.mjs",
            modules: { "index.mjs": { type: "esm", contents: code } },
          },
          env: {
            DB: { type: "d1", id: "DB" },
            AUTH_MODE: text("trial"),
            AUTH_PEPPER: text(pepper),
            WALLET_ACCESS: text("enabled"),
            FEE_PAYER_SECRET: text(bs58.encode(sponsor.secretKey)),
          },
        },
        dev: { outboundService: { type: "fetcher", handler: rpcRequest } },
      },
    ],
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  for (const file of [
    "0001_auth",
    "0002_wallet_access",
    "0003_relay_receipts",
  ]) {
    const sql = await readFile("migrations/" + file + ".sql", "utf8");
    for (const stmt of sql
      .trim()
      .split(/;\s*(?=CREATE |$)/)
      .filter(Boolean))
      await db.prepare(stmt).run();
  }
  await db
    .prepare(
      "INSERT INTO members(id,realm,address,type,pin_mac,created) VALUES('buyer','trial',?,'phantom','fixture',1)",
    )
    .bind(String(user))
    .run();
  await db
    .prepare("INSERT INTO wallet_tickets VALUES(?,'trial','session',?,?)")
    .bind(
      createHmac("sha256", pepper)
        .update("wallet-access/trial/ticket\n" + session)
        .digest("base64"),
      JSON.stringify({ id: "buyer", revision: 1 }),
      Math.floor(Date.now() / 1000) + 900,
    )
    .run();
  const base = "https://wara.example";
  const post = (path, body) =>
    runtime.dispatchFetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.deepEqual(
    await (await runtime.dispatchFetch(base + "/api/fee-payer")).json(),
    { feePayerPubkey: String(sponsor.publicKey) },
  );
  assert.equal((await post("/api/relay", {})).status, 401);
  const profile = { managed: true, type: "phantom", address: String(user) };
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      value: storage,
      configurable: true,
    });
    t.after(() =>
      old
        ? Object.defineProperty(globalThis, name, old)
        : delete globalThis[name],
    );
  }
  storage.setItem(
    "wara.member",
    JSON.stringify({ profile, session, expires: Date.now() + 900000 }),
  );
  let drop = false,
    lastBody;
  t.mock.method(globalThis, "fetch", async (path, opts) => {
    const res = await runtime.dispatchFetch(base + path, opts);
    if (path === "/api/relay") {
      lastBody = JSON.parse(opts.body);
      assert.equal(res.status, 200, await res.clone().text());
      if (drop) throw Error("Dropped response after successful broadcast");
    }
    return res;
  });
  t.mock.method(rpc, "getGenesisHash", async () => DEVNET_GENESIS);
  t.mock.method(rpc, "getBalance", async () =>
    assert.fail("sponsored buyer balance check"),
  );
  t.mock.method(rpc, "getAccountInfo", async (k) => account(k));
  t.mock.method(rpc, "getMinimumBalanceForRentExemption", async (n) =>
    minRent(n),
  );
  t.mock.method(rpc, "getLatestBlockhash", async () => ({
    blockhash: svm.latestBlockhash(),
    lastValidBlockHeight: 100,
  }));
  t.mock.method(rpc, "getSignatureStatuses", async ([id]) => ({
    value: [
      broadcast.includes(id) ? { confirmationStatus: "confirmed" } : null,
    ],
  }));
  t.mock.method(rpc, "getBlockHeight", async () => 1);
  const wallet = async () => ({
    publicKey: user,
    signTransaction: async (tx) => {
      tx.partialSign(buyer);
      return tx;
    },
  });
  const mint = mintFor(program, g);
  const balance = (k) => account(ata(mint, k)).data.readBigUInt64LE(64);
  assert.equal(account(user), null);
  await submit(
    profile,
    wallet,
    [join(program, user, g, user, false, invite.publicKey)],
    [invite],
  );
  const day = (svm.getClock().unixTimestamp + 32400n) / 86400n;
  await submit(profile, wallet, spend(program, user, g, merchant, 1n, day, 0n));
  assert.equal(balance(merchant), 90n);
  assert.equal(balance(user), 10n);
  assert.equal(account(ata(mint, secondShop)), null);
  drop = true;
  await assert.rejects(
    submit(
      profile,
      wallet,
      transfer(program, user, g, secondShop, [{ origin: g, amount: 3n }]),
    ),
    /送信結果を確認中/,
  );
  assert.equal(await checkPending(String(user)), broadcast[2]);
  assert.equal(balance(merchant), 90n);
  assert.equal(balance(secondShop), 3n);
  assert.equal(balance(user), 7n);
  assert.equal(account(user)?.lamports ?? 0, 0);
  assert.deepEqual(await (await post("/api/relay", lastBody)).json(), {
    signature: broadcast[2],
  });
  assert.equal(broadcast.length, 3);
  // A configured service explicitly reporting no sponsor must use the
  // original balance check before asking the wallet to sign.
  t.mock.method(globalThis, "fetch", async (path) => {
    assert.equal(path, "/api/fee-payer");
    return Response.json({ feePayerPubkey: null });
  });
  t.mock.method(rpc, "getBalance", async () => 0);
  await assert.rejects(
    submit(profile, wallet, spend(program, user, g, merchant, 1n, day, 1n)),
    /Devnet SOL/,
  );
});

test("relay rejects extra SOL debits, rent or ATA substitutions, unsigned actors, forged invites and unsupported programs before broadcast", async () => {
  const sponsor = key(),
    buyer = key(),
    group = key().publicKey,
    other = key().publicKey;
  const user = buyer.publicKey,
    fee = sponsor.publicKey;
  const base = [...budgetInstructions(), join(program, user, group, user)];
  const rent = 1_000_000;
  const canonical = () => sponsoredInstructions(base, fee, rent);
  const rpc = {
    getGenesisHash: async () => DEVNET_GENESIS,
    getAccountInfo: async () => null,
    getMinimumBalanceForRentExemption: async () => rent,
    isBlockhashValid: async () => ({ value: true }),
    sendRawTransaction: () => assert.fail("broadcast"),
  };
  const fees = { find: async () => null, insert: () => assert.fail("receipt") };
  async function denied(instructions, sign = true, member = String(user)) {
    const tx = new Transaction({
      feePayer: fee,
      recentBlockhash: String(key().publicKey),
    }).add(...instructions);
    if (sign) tx.partialSign(buyer);
    await assert.rejects(
      relayPayment({
        encoded: wire(tx),
        sponsor,
        member,
        receipts: fees,
        rpc,
        reserveBudget: () => assert.fail("budget"),
        fail: (status) => {
          throw Error("reject " + status);
        },
      }),
      /reject (400|409)/,
    );
  }
  const costly = canonical();
  costly[1].data.writeBigUInt64LE(999999n, 1);
  await denied(costly);
  await denied([
    ...canonical(),
    SystemProgram.transfer({ fromPubkey: fee, toPubkey: other, lamports: 1 }),
  ]);
  const redirect = canonical();
  redirect[2].keys[1].pubkey = other;
  await denied(redirect);
  await denied(sponsoredInstructions(base, fee, rent + 1));
  await denied(canonical(), false);
  await denied(canonical(), true, String(other));
  const invite = key().publicKey;
  await denied(
    sponsoredInstructions(
      [
        ...budgetInstructions(),
        join(program, user, group, user, false, invite),
      ],
      fee,
      rent,
    ),
  );
  const alias = canonical();
  alias.at(-1).keys.push({ pubkey: fee, isSigner: true, isWritable: true });
  await denied(alias);
  const ataIx = sponsoredInstructions(
    [budgetInstructions()[1], ...spend(program, user, group, other, 1, 1, 0)],
    fee,
    0,
  );
  ataIx[2].keys[2].pubkey = user;
  await denied(ataIx);
});
