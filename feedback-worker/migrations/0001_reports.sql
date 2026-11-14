-- Every report a tester's install sends. One table: crashes, errors and
-- repeated actions are grouped by `fingerprint` at read time (see
-- queries.sql), not here, so nothing is lost by grouping wrongly.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  occurred_at TEXT,
  kind TEXT NOT NULL,
  category TEXT,
  install_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  fingerprint TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  context TEXT,
  log TEXT,
  -- Triage, set by hand or by the review loop: new, seen, fixed, wontfix.
  status TEXT NOT NULL DEFAULT 'new',
  note TEXT
);

CREATE INDEX reports_kind_received ON reports (kind, received_at);
CREATE INDEX reports_fingerprint ON reports (fingerprint, received_at);
CREATE INDEX reports_install_received ON reports (install_id, received_at);
CREATE INDEX reports_status ON reports (status, received_at);
