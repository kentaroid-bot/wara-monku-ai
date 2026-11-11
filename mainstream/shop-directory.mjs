// Hide these retired Devnet examples from discovery only. Existing receipts and links keep their IDs.
const HIDDEN_SEED_GROUPS = new Set([
  "4SuDmQR72DnjC5GZ78oDk7u4G2w5edNFuVGKFRfEZsLU",
  "EX9aaEQJ4Uzd6ydpJbP4G32i3udkdg6VdVLsXZ3PWtLa",
  "HWN3xPwGBAd9UjNgU34eFvVSjEVo74ow16TgBMrxi1pD",
  "J9PGMWgkXXH2dhoZpdGtNyRA2xbtmLJPM4SnGWMvE3wC",
]);

export const listedGroups = groups => groups.filter(g => !HIDDEN_SEED_GROUPS.has(g.id));

export function joinedGroupIds({groups, rows}, who) {
  const ids = new Set(groups.filter(g => g.owner === who).map(g => g.id));
  for (const r of rows)
    if (r.tag === 33 && r.to === who && r.status === 2) ids.add(r.group);
  return ids;
}

export function registerChoices(stores, state, who, receiving) {
  const joined = receiving ? null : joinedGroupIds(state, who);
  return stores.filter(st => !HIDDEN_SEED_GROUPS.has(st.group) &&
    (receiving ? st.to === who : joined.has(st.group)));
}
