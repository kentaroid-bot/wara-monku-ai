CREATE TABLE wallets (
  phone_key TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  login_key TEXT NOT NULL
);
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  phone_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('activate', 'signin')),
  code_mac TEXT NOT NULL,
  expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX challenges_expiry ON challenges(expires);
CREATE TABLE issue_limits (
  bucket TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX issue_limits_expiry ON issue_limits(expires);
