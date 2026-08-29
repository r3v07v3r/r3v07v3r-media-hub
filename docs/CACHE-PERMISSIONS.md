# r3-cache permissions — design

Agreed 2026-08-29, to be built after the next major release. Three requirements, one feature:

1. Each person sees their own connection to the cache server.
2. What a person caches is **private by default** — optionally shared with everyone, or with
   specific people.
3. One **administrator** controls service-wide settings, claimed by the first person to pair.

## What is true today

Worth stating precisely, because half the machinery already exists and the other half is a real
hole.

**Already correct.** Pairing is anchored on a 6-digit code printed on the daemon's own console
(`pairing.ts`): single-use, rotated on every success and after repeated failures, and throttled.
Credentials are per device — `credentials.ts` keys TorBox tokens by `deviceIdForToken`, a hash of
the bearer token — and every job records `ownerDeviceId`, so **a fetch only ever bills its own
owner's account, never a housemate's**. `server.ts` already computes `callerDeviceId` on every
authenticated route.

**The hole.** Nothing uses it for reading. `GET /api/catalog` with no `keys` filter returns
**every cached item, with titles, to any paired device** — so anybody in the house can enumerate
what everyone else has been watching. `GET /stream/{infoHash}` authorises on "is this token
paired", not on who owns the item. Ownership is enforced for _spending_ and ignored for _seeing_.

That is the thing to fix first, and it is the whole of requirement 2 in practice.

## Administrator

**Claimed by the first device to pair, and that is safe because of what pairing already requires.**
A first-come race over the network would be a bad idea; this is not one. Pairing needs the code off
the console, so the first pairing is by definition somebody with access to the machine the daemon
runs on — the person who installed it. No new secret, no new trust assumption, and no setup step.

- Recorded as `adminDeviceId` in the daemon's own state, not derived from the token.
- **Recovery goes through the console, because the console is the root of trust.** Re-pairing mints
  a new token and therefore a new device id, which would otherwise orphan the admin role forever.
  A `--claim-admin` flag (and a printed banner when no admin is set) covers a lost token, a
  reinstalled app, or a replaced laptop.
- Admin controls **the service**: disk budget, TTLs, port, server name, updater channel, the device
  list, and revoking a device.

**Admin is not a master key over other people's libraries, and the UI must not imply it is.** The
person with admin also has a shell on that box and can read every file in the data directory. Any
claim that admin cannot see private items would be a lie told by the interface. So: admin manages
the service and sees aggregate usage; admin does not get a "browse everyone's items" screen. State
the real boundary rather than inventing a fake one.

## Item visibility

Add to `ItemMeta` (`storage.ts`):

```ts
visibility: 'private' | 'shared'   // default 'private'
entitled: string[]                 // device ids that may list and stream this
```

- `GET /api/catalog` returns only items where the caller is entitled, or `visibility === 'shared'`.
- `GET /stream/{infoHash}` authorises on the same rule instead of on "is paired".
- Aggregate figures (`usedBytes`, `itemCount`) stay whole-server — you need to know the disk is
  full without being told whose fault it is.
- A per-device default ("share everything I fetch") plus a per-item override, both in the app's
  Cache server card.

### The dedupe tension, which is the real design problem

A cache exists to hold **one** copy and download it **once**. Private-by-default collides with
that head-on: if B wants a film A already has privately, fetching a second copy doubles the disk
and the bandwidth and defeats the point of running the daemon at all.

**Resolution: one copy on disk, a set of entitled devices.** When B independently requests an
infoHash that is already held, B is added to `entitled` and streams the existing copy rather than
re-fetching it. This leaks nothing that matters — B asked for that exact release, so B already
knew it existed, and B could have fetched it with their own account regardless. Deleting A's
entitlement then removes the file only when nobody else holds one.

**The residual leak, named honestly:** B learns from the timing that the file was already there.
That is a weak side channel and it is the price of a shared cache being shared. It is not worth
closing with a fake delay; it is worth writing down.

**A budget consequence to decide when building:** one file entitled to three people is charged to
whom, for LRU eviction? Simplest defensible rule — the file is charged once, and last-access is
the newest across all entitled devices, so a copy somebody is still watching is not evicted
because its original fetcher lost interest.

## Sharing with specific people

`entitled` is already a list, so "share with Jules but not the lounge TV" is the same mechanism
with a different write. What it needs on top is a **name**: today a device is a hash of a bearer
token, which is unusable in a picker. The device name is already collected at pairing
(`tryPair(code, deviceName)`) and simply never surfaced — expose it in the device list and the
whole feature becomes a checkbox list of names.

## Protocol additions

| Where                            | Change                                                                      |
| -------------------------------- | --------------------------------------------------------------------------- |
| `ItemMeta`                       | `visibility`, `entitled[]`                                                  |
| `LanCacheStatusResponse.jobs[]`  | owner **name** (not device id) — already needed for the Server dashboard    |
| `LanCacheStatusResponse`         | `isAdmin`, and a device list for admins: name, paired-at, linked, last seen |
| `GET /api/catalog`               | filter by entitlement                                                       |
| `GET /stream/{infoHash}`         | authorise by entitlement                                                    |
| `POST /api/items/{hash}/sharing` | new — set visibility / entitled, owner or admin only                        |
| `POST /api/admin/settings`       | new — budget, TTLs, name, updater channel; admin only                       |
| `--claim-admin`                  | new console flag, for recovery                                              |

## Migration

Every existing item predates this and has no `visibility`. Defaulting them to `private` would
silently strip access that people currently have; defaulting to `shared` would silently publish
what they cached before the rule existed. Neither is safe to do quietly, so: **existing items
become `entitled: [ownerDeviceId]` with `visibility: 'private'`, and the app says once, plainly,
that previously-shared items are now private and can be re-shared.** Items whose `ownerDeviceId`
is unknown — the pre-multi-user file `credentials.ts` already documents — become `shared`, because
nobody can be identified as their owner and stranding them where no one can reach them is worse.

## What this is not

Household courtesy with real API enforcement, not multi-tenant isolation. Visibility is a rule the
daemon applies, not encryption: anyone with shell access to the box reads everything. The device
identity is a bearer token — whoever holds it is that device. Say all of this in the UI where
somebody might otherwise assume otherwise.
