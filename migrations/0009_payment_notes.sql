CREATE TABLE payment_notes (
  realm TEXT NOT NULL,
  payer_signature TEXT NOT NULL,
  shop TEXT NOT NULL,
  note TEXT NOT NULL,
  confirmed_signature TEXT,
  PRIMARY KEY (realm, payer_signature)
);
