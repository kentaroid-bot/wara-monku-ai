export async function memberSettings(op, core) {
  const { b, db, realm, query, hash, consumePhone, ticket, profile, session,
    validPin, alias, cardValues, strong, origin, bad, denied, fail } = core;
  const { m } = await session();
  if (op === "edit-proof") {
    if (m.type !== "phantom" || !["alias", "link", "pin", "cards"].includes(b.purpose)) bad();
    return {
      audience: origin,
      ticket: await ticket("edit", { id: m.id, purpose: b.purpose, revision: m.revision }),
    };
  }

  const stmts = [], fields = [], values = [];
  // D1 executes this batch atomically. Guard every auxiliary write with the
  // original revision, then advance it in the final UPDATE. A stale request
  // changes neither the settings nor the cards/phone mapping.
  const unchanged = "EXISTS (SELECT 1 FROM members WHERE id=? AND revision=?)";
  const guard = [m.id, m.revision];
  if (op === "alias") {
    const a = await alias(m.id);
    fields.push("name_key=?", "answers=?");
    values.push(a.nameKey, a.answers);
  }
  if (op === "link") {
    if (m.phone_key || realm !== "verified") fail(409, "電話番号を追加できません。");
    const phone = await consumePhone("activate");
    if (await query("SELECT 1 FROM wallets WHERE phone_key=?", phone).first()) denied();
    stmts.push(query(
      "INSERT INTO wallets SELECT ?,?,'managed' WHERE " + unchanged,
      phone, JSON.stringify(profile(m)), ...guard,
    ));
    fields.push("phone_key=?");
    values.push(phone);
  }
  if (op === "pin") {
    validPin(b.newPin);
    fields.push("pin_mac=?");
    values.push(await hash("pin", m.id + ":" + b.newPin));
  }
  if (op === "cards") {
    if (m.type === "phantom") bad();
    cardValues();
    stmts.push(query(
      "DELETE FROM wallet_codes WHERE member_id=? AND " + unchanged,
      m.id, ...guard,
    ));
    for (const [index, code] of b.codes.entries()) {
      stmts.push(query(
        "INSERT INTO wallet_codes SELECT ?,?,? WHERE " + unchanged,
        m.id, await hash("strong", code), Number(index === 5), ...guard,
      ));
    }
    fields.push("card_key=?");
    values.push(await hash("card", b.card));
  }
  await strong(m, op);
  fields.push("revision=revision+1");
  stmts.push(query(
    "UPDATE members SET " + fields.join(",") + " WHERE id=? AND revision=?",
    ...values, ...guard,
  ));
  const results = await db.batch(stmts);
  if (results?.at(-1)?.meta?.changes === 0)
    fail(409, "アカウント設定が別の操作で更新されました。もう一度お試しください。");
  return { reauth: true };
}
