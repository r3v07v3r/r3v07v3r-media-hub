# Cloudflare tracking-sync design

## Scope

Synchronize only portable viewing state between a user's devices:

- tracked title IDs and list state
- watched movie/episode events
- playback progress
- conflict/version timestamps

Never upload TorBox tokens, Simkl access tokens, temporary playback URLs, torrent credentials, or Windows-encrypted local secrets.

## Proposed Cloudflare components

- **Worker**: versioned HTTPS API and authentication boundary.
- **D1**: users, devices, pairing codes, events, and compacted state.
- **Durable Object (optional)**: serialize writes per account and support future watch-party state.
- **Turnstile (optional)**: protect account creation and PIN attempts from abuse.

Deployment is intentionally deferred until the owner approves any cost and provides a Cloudflare account/domain configuration.

## Account and device authentication

1. The first device generates a random 256-bit recovery/auth key locally.
2. The Worker stores only a one-way hash of that key.
3. The raw key is shown once to the user and stored locally with Electron `safeStorage`.
4. The authenticated first device requests a short, human-readable pairing PIN.
5. The Worker stores a hashed PIN with account ID, expiry (10 minutes), attempt limit, and one-use status.
6. A new device enters the PIN and receives its own revocable random device token.
7. Device tokens are hashed in D1 and stored locally with `safeStorage`.
8. Pairing is rate-limited by IP, account, and PIN. A PIN is invalidated immediately after success.

A PIN must never itself become a long-lived credential.

## Data model

- `accounts(id, recovery_key_hash, created_at)`
- `devices(id, account_id, token_hash, name, created_at, last_seen_at, revoked_at)`
- `pairing_codes(id, account_id, pin_hash, expires_at, attempts, used_at)`
- `sync_events(id, account_id, device_id, entity_type, entity_key, operation, payload_json, logical_clock, created_at)`
- `sync_state(account_id, entity_type, entity_key, payload_json, logical_clock, updated_at)`

## Conflict behavior

- Tracked/untracked: latest logical clock wins.
- Watched events: append-only and idempotent by event ID.
- Playback progress: latest timestamp wins unless a completed event exists.
- Deletes use tombstones so offline devices cannot resurrect removed state.
- SQLite remains the local source for immediate UI and an offline outbound queue.

## API outline

- `POST /v1/accounts` — create account and return recovery key once
- `POST /v1/pairing-codes` — authenticated device creates PIN
- `POST /v1/pair` — exchange PIN for device token
- `GET /v1/sync?cursor=...` — incremental changes
- `POST /v1/sync` — idempotent event batch
- `GET /v1/devices` — list linked devices
- `DELETE /v1/devices/:id` — revoke a device

## Privacy and operations

- Use HTTPS only and strict JSON size limits.
- Encrypt sensitive payload columns where practical; keep provider credentials out entirely.
- Log request IDs and status, never auth headers, PINs, recovery keys, or payload contents.
- Provide account/device deletion.
- Add D1 migration backups and API schema versioning before production.
- Verify current Cloudflare free-tier and paid limits before deployment; incur no cost without owner approval.
