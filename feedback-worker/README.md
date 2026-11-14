# r3-feedback

Where testers' reports from R3 Media Hub go: typed feedback, crashes,
errors the app survived, repeated actions, and unclean shutdowns. They are
stored in a Cloudflare D1 database called `r3-feedback`.

## What is sent, and what is not

The app cleans every report before it leaves the machine
(`src/shared/feedback/sanitize.ts`), and this Worker runs the same rules
again before storing anything.

- A user folder keeps only what comes after the account name:
  `C:\Users\Sam\AppData\…` becomes `%USERPROFILE%\AppData\…`, and
  `/home/sam/…` becomes `~/…`.
- The account name and computer name are replaced wherever they appear.
- URLs keep only the host, and only for known public services (TorBox,
  Simkl, Trakt, TMDB and others). Anything else, such as a Jellyfin domain,
  a party relay or a LAN address, becomes `[url]`.
- IP and MAC addresses, emails, tokens, keys, passwords, magnets,
  info-hashes and network share names are replaced with markers.
- No IP address is stored. The rate limiter uses it as a key and forgets it.

Each install has a random id, so "seen on 4 machines" can be counted
without knowing whose machines they are.

## Nobody can read reports through the Worker

The Worker only accepts POSTs to `/v1/reports`. No route returns a stored
report, so the URL in the app's public source can't be used to scrape them.
Reading them needs the Cloudflare account. See `queries.sql`.

## Limits

- 30 requests a minute per address, 20 reports per request, and 256 KB per
  request.
- 300 reports a day per install.
- Logs are dropped after 60 days and reports deleted after a year (daily
  cron).

## Deploy

```bash
npm ci
npx wrangler d1 migrations apply r3-feedback --remote
npx wrangler deploy
```

The app sends to `https://r3-feedback.unit.workers.dev/v1/reports`
(`FEEDBACK_ENDPOINT` in `src/shared/feedback/types.ts`).
