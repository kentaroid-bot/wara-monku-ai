import { Buffer } from "buffer";
import { pk, mintFor, tok } from "./protocol.mjs";
import { groupCreatedKey } from "./storage-keys.mjs";

export const selectableModes = group => group?.mode === 0 ? [0, 1, 2] : [1, 2];

export function memberCounts(groups, rows) {
  const members = new Map(groups.map(g => [g.id, new Set([g.owner])]));
  for (const r of rows) if (r.tag === 33 && r.status === 2) members.get(r.group)?.add(r.to);
  return new Map([...members].map(([id, people]) => [id, people.size]));
}

const descending = (a, b) => a === b ? 0 : a > b ? -1 : 1;
export function sortPublicGroups(groups, rows, sort = "members", supplies = new Map(), created = new Map()) {
  const counts = memberCounts(groups, rows);
  const useTime = groups.every(g => !created.has(g.id) || created.get(g.id).blockTime != null);
  return [...groups].sort((a, b) => {
    let order;
    if (sort === "wara") order = descending(supplies.get(a.id) ?? 0n, supplies.get(b.id) ?? 0n);
    else if (sort === "new") {
      const x = created.get(a.id), y = created.get(b.id);
      // Compare slots when either timestamp is unavailable, keeping units consistent.
      order = x && y ? descending(useTime ? x.blockTime : x.slot, useTime ? y.blockTime : y.slot) : descending(Boolean(x), Boolean(y));
    } else order = descending(counts.get(a.id), counts.get(b.id));
    return order || a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id);
  });
}

export function mintSupply(account) {
  return account?.owner?.equals(tok) && account.data?.length === 82
    ? Buffer.from(account.data).readBigUInt64LE(36) : 0n;
}

// One loader per view: on-demand reads share in-flight work and never fetch balances.
export function directoryMetrics({ rpc, program, storage }) {
  const supplies = new Map(), created = new Map(), persistent = new Map(), pending = new Map();
  let supplyVersion = 0;
  function resetSupplies() {
    supplyVersion++;
    supplies.clear();
    pending.delete("wara");
  }
  const key = groupCreatedKey(program);
  try {
    for (const [id, value] of Object.entries(JSON.parse(storage?.getItem(key) || "{}"))) {
      if (Number.isSafeInteger(value?.slot) && value.slot >= 0 &&
          (value.blockTime === null || (Number.isFinite(value.blockTime) && value.blockTime >= 0))) {
        created.set(id, value); persistent.set(id, value);
      }
    }
  } catch { /* Storage can be unavailable or contain an older/invalid value. */ }
  const save = () => {
    try { storage?.setItem(key, JSON.stringify(Object.fromEntries(persistent))); } catch {}
  };
  async function loadWara(groups, alive) {
    const version = supplyVersion;
    const missing = groups.filter(g => !supplies.has(g.id));
    for (let i = 0; i < missing.length && alive() && version === supplyVersion; i += 100) {
      const chunk = missing.slice(i, i + 100);
      try {
        const accounts = await rpc.getMultipleAccountsInfo(chunk.map(g => mintFor(program, g.id)));
        if (version !== supplyVersion) return;
        chunk.forEach((g, index) => supplies.set(g.id, mintSupply(accounts?.[index])));
      } catch {
        if (version !== supplyVersion) return;
        chunk.forEach(g => supplies.set(g.id, 0n));
      }
    }
  }
  async function loadNew(groups, alive) {
    const queue = groups.filter(g => !created.has(g.id));
    async function worker() {
      while (queue.length && alive()) {
        const g = queue.shift();
        let before, oldest;
        try {
          for (let page = 0; page < 5 && alive(); page++) {
            const signatures = await rpc.getSignaturesForAddress(pk(g.id), { limit: 1000, ...(before ? {before} : {}) });
            if (signatures.length) oldest = signatures.at(-1);
            if (oldest) created.set(g.id, {blockTime:oldest.blockTime ?? null, slot:oldest.slot});
            if (signatures.length < 1000) {
              if (oldest) { persistent.set(g.id, created.get(g.id)); save(); }
              break;
            }
            before = oldest.signature;
          }
        } catch { /* Keep an available estimate in memory, never persist incomplete history. */ }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
  }
  function load(sort, groups, alive = () => true) {
    if (sort !== "wara" && sort !== "new") return Promise.resolve();
    if (!pending.has(sort)) {
      const publicGroups = groups.filter(g => g.visibility !== "private");
      const task = (sort === "wara" ? loadWara : loadNew)(publicGroups, alive)
        .finally(() => { if (pending.get(sort) === task) pending.delete(sort); });
      pending.set(sort, task);
    }
    return pending.get(sort);
  }
  return {supplies, created, load, resetSupplies};
}
