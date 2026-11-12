CREATE TABLE private_community_names (
  realm TEXT NOT NULL,
  group_id TEXT NOT NULL,
  version TEXT NOT NULL,
  sealed_name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (realm, group_id, version)
);
