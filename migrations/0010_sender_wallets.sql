ALTER TABLE members ADD COLUMN sender_address TEXT;
ALTER TABLE members ADD COLUMN sender_sealed_seed TEXT;
ALTER TABLE members ADD COLUMN sender_rotated_at INTEGER;
ALTER TABLE members ADD COLUMN carried_day INTEGER;
ALTER TABLE members ADD COLUMN carried_spent INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS members_by_sender ON members(realm, sender_address) WHERE sender_address IS NOT NULL;
CREATE TABLE retired_sender_accounts (
  id TEXT PRIMARY KEY,
  realm TEXT NOT NULL,
  kind INTEGER NOT NULL,
  target_address TEXT NOT NULL,
  group_id TEXT,
  created INTEGER NOT NULL
);
