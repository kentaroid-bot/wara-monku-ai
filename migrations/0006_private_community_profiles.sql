CREATE TABLE private_community_profiles (
  realm TEXT NOT NULL,
  group_id TEXT NOT NULL,
  version TEXT NOT NULL,
  sealed_profile TEXT NOT NULL,
  PRIMARY KEY (realm, group_id, version)
);
