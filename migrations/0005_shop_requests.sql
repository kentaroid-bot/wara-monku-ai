CREATE TABLE shop_requests (
  realm TEXT NOT NULL,
  group_id TEXT NOT NULL,
  merchant TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  PRIMARY KEY (realm, group_id, merchant)
);
