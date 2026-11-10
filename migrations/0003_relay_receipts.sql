-- Transaction identifiers only; enables reconciliation after an HTTP timeout.
CREATE TABLE relay_receipts (
  receipt TEXT PRIMARY KEY,
  signature TEXT NOT NULL
);
