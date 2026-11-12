-- Only the server can populate this mirror. group_json holds the public chain
-- envelope (ciphertext for a private group), never the decrypted display name.
CREATE TABLE community_access (
  realm TEXT NOT NULL,
  program TEXT NOT NULL,
  group_id TEXT NOT NULL,
  viewer TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  group_json TEXT,
  valid_until INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  live_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(realm,program,group_id,viewer)
);
