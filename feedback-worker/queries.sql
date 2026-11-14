-- Ready-made reads for the feedback database. Run one with:
--   npx wrangler d1 execute r3-feedback --remote --command "<query>"

-- Typed feedback, newest first.
SELECT id, received_at, category, app_version, title, body
FROM reports WHERE kind = 'feedback' AND status = 'new'
ORDER BY received_at DESC LIMIT 50;

-- Problems grouped: how often, on how many machines, which versions.
SELECT kind, fingerprint, MIN(title) AS title, COUNT(*) AS times,
       COUNT(DISTINCT install_id) AS machines,
       GROUP_CONCAT(DISTINCT app_version) AS versions,
       MIN(received_at) AS first_seen, MAX(received_at) AS last_seen
FROM reports
WHERE kind IN ('crash', 'error', 'friction', 'unclean-exit')
  AND received_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
GROUP BY kind, fingerprint
ORDER BY machines DESC, times DESC LIMIT 50;

-- One problem in full, with its most recent log.
SELECT * FROM reports WHERE fingerprint = ? ORDER BY received_at DESC LIMIT 1;

-- Mark a problem dealt with.
UPDATE reports SET status = 'fixed', note = ? WHERE fingerprint = ?;
