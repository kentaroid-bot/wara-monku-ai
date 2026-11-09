CREATE TABLE members (
  id TEXT PRIMARY KEY,
  realm TEXT NOT NULL,
  address TEXT NOT NULL,
  type TEXT NOT NULL,
  phone_key TEXT UNIQUE,
  name_key TEXT,
  answers TEXT,
  pin_mac TEXT NOT NULL,
  sealed_seed TEXT,
  card_key TEXT UNIQUE,
  sponsor_id TEXT REFERENCES members(id),
  created INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(realm,address)
);
CREATE INDEX members_by_name ON members(realm,name_key);
CREATE INDEX members_by_sponsor ON members(sponsor_id,created);
CREATE TABLE wallet_tickets (
  token TEXT PRIMARY KEY,
  realm TEXT NOT NULL,
  purpose TEXT NOT NULL,
  detail TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX wallet_tickets_expiry ON wallet_tickets(expires);
CREATE TABLE wallet_codes (
  member_id TEXT NOT NULL REFERENCES members(id),
  code_key TEXT PRIMARY KEY,
  reserve INTEGER NOT NULL CHECK(reserve IN (0,1))
);
CREATE TRIGGER sponsor_daily_limit BEFORE INSERT ON members
WHEN NEW.sponsor_id IS NOT NULL AND
 (SELECT count(*) FROM members WHERE sponsor_id=NEW.sponsor_id AND created>NEW.created-86400)>=3
BEGIN
 SELECT RAISE(ABORT,'sponsor_daily_limit');
END;
