CREATE TABLE shop_profiles (
  realm TEXT NOT NULL,
  shop TEXT NOT NULL,
  group_id TEXT NOT NULL,
  merchant TEXT NOT NULL,
  title TEXT NOT NULL,
  caption TEXT NOT NULL,
  icon TEXT NOT NULL,
  is_test INTEGER NOT NULL CHECK (is_test IN (0,1)),
  revision INTEGER NOT NULL,
  PRIMARY KEY (realm, shop)
);
