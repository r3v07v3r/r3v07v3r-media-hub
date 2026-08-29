# r3-cache permissions — design

Agreed 2026-08-29. **Built 2026-08-29**, in the order this document
mandates: entitlement, the Super Admin claim, device approval, per-device
allocation, then — and only then — the removal of the pairing code.

Two things landed differently from the plan below, both deliberately and
both documented at the point of departure in the code:

- **The job list is scoped, not annotated.** This document called for jobs
  to gain an owner name. `/api/status` already handed every paired device
  the TITLES of everything the household was fetching — the same read-side
  hole entitlement closes on the catalog, sitting on the queue instead of
  the disk — so adding names would have widened it from "what does this
  household watch" to "who watches what". A device now sees its own queue
  and a COUNT of everyone else's.
- **The join request is throttled and the pending queue is capped.** The
  six-digit code was brute-forceable, so attempts were rate-limited. Asking
  to join is not a guess, so there is nothing to brute-force — but the
  request is now unauthenticated, and without a bound anyone on the network
  could fill an administrator's approval list and the daemon's auth.json.

The rest is as written.

1. **No pairing code.** Reading a 6-digit code off `journalctl` is the worst step in the product.
2. What a person caches is **private by default** — shareable with everyone, or with named people.
3. A **Super Admin**, claimed with a button by the first person to connect, who configures sharing,
   the disk budget, and each person's allocation.
4. Everyone else pairs freely and gets a reasonable default allocation.

Requirements 1 and 2 are **one decision, not two**, and the order matters — see below.

## What is true today

**Already correct.** Credentials are per device (`credentials.ts` keys TorBox tokens by
`deviceIdForToken`, a hash of the bearer token) and every job records `ownerDeviceId`, so **a fetch
only ever bills its own owner's account, never a housemate's**. `server.ts` already computes
`callerDeviceId` on every authenticated route.

**The hole.** Nothing uses it for reading. `GET /api/catalog` with no `keys` filter returns **every
cached item, with titles, to any paired device**, and `GET /stream/{infoHash}` authorises on "is
this token paired" rather than on who owns the item. Ownership is enforced for _spending_ and
ignored for _seeing_.

**And the useful discovery: the app never asks for the unfiltered listing.** `lanCacheFeeder.ts`
always calls `lanCacheCatalog(wanted.map(e => e.contentKey))` with keys derived from its own
watchlist, and resolve asks about exactly one key. The unfiltered branch of `/api/catalog` is dead
weight for the product and exists only as a leak. It can be deleted rather than fixed.

## Dropping the pairing code

The code is a real usability failure and removing it is the right call — **but it is only safe
because private-by-default lands at the same time, and it must not ship before it.**

Today "paired" means "may stream everything". Remove the code from _that_ and anyone on the LAN can
watch the whole cache. Once entitlement is enforced, pairing buys almost nothing on its own: a new
device can see its own items, spend its own TorBox token, and use its own allocation. That is what
makes open pairing reasonable, so the build order is not negotiable — **entitlement first, then
remove the code.**

### What replaces it, keeping zero friction

**In-app approval, not a code.** After a Super Admin exists, a new device pairing appears in the
admin's app as a request — device name, LAN address, time — with Allow and Deny. That is strictly
better UX than reading a console: nothing to type, nothing to transcribe, and the admin sees who
is asking instead of handing out a secret that any recipient can reuse.

Optionally a per-admin "let anyone on this network join" switch, for a household that genuinely
does not want to be asked. That is the user's original proposal, kept as a deliberate choice rather
than the unavoidable default.

### Claiming Super Admin

The button is right. The bound is what needs care: **pure first-come leaves an unclaimed headless
daemon open to whoever finds it first**, and this daemon is advertised over mDNS and designed to
run at boot on a box nobody looks at. A week later the first person to open the app is not
necessarily the installer.

So: **claimable while unclaimed, and the daemon says loudly that it is unclaimed** — a console
banner every few minutes and, more usefully, an `unclaimed: true` flag on `/api/ping` so any app
that discovers it can offer the button prominently. The realistic exposure is then the minutes
between installing the daemon and opening the app, which is the same window a printed code had
anyway, without the typing.

For the paranoid case and for recovery: `--claim-admin` on the console re-opens claiming. The
console stays the root of trust — not because people should have to use it, but because on a box
you physically control it is the only thing that cannot be taken from you remotely.

**Admin manages the service, not other people's libraries.** They also have a shell on that box and
can read every file, so an interface claiming otherwise would be lying. Admin gets service settings,
aggregate usage, the device list and the ability to revoke a device. Admin does not get a "browse
everyone's items" screen.

## Item visibility

Add to `ItemMeta` (`storage.ts`):

```ts
visibility: 'private' | 'shared'   // default 'private'
entitled: string[]                 // device ids that may see and stream this
```

### Ask by hash, and scope the answer to who is asking

The user's instinct — send a hash, get back yes or no — is right, and the app is already shaped for
it. But **narrowing the shape of the answer is not what makes it private; scoping it is.**

A daemon that answers "do you have `<hash>`?" honestly for anyone is still fully enumerable: torrent
hashes for popular titles are public, so anyone can walk a list of a few thousand films and learn
exactly what the household has been watching. The fix is that a hash the caller is not entitled to
must answer **exactly** as a hash that is not there at all — same body, same status, no timing
difference worth measuring. "Not for you" and "not here" have to be indistinguishable.

With that, probing tells an attacker nothing they did not already know, and:

- `GET /api/catalog?keys=…` returns only entitled or shared items. **The unfiltered branch is
  deleted** — nothing in the app uses it.
- `GET /stream/{infoHash}` authorises on entitlement, not on "is paired".
- Aggregate figures (`usedBytes`, `itemCount`) stay whole-server: you need to know the disk is full
  without being told whose fault it is.

### The dedupe tension, which is the real design problem

A cache exists to hold **one** copy and download it **once**. Private-by-default collides with that:
if B wants a film A already has privately, fetching a second copy doubles the disk and the bandwidth
and defeats the point of running the daemon.

**One copy on disk, a set of entitled devices.** When B independently requests an infoHash already
held, B is added to `entitled` and streams the existing copy instead of re-fetching. B asked for
that exact release, so this reveals nothing B did not already know, and B could have fetched it with
their own account regardless. Removing A's entitlement deletes the file only when nobody else holds
one.

**The residual leak, named honestly:** B learns from the speed that the file was already there. A
weak side channel, and the price of a shared cache being shared. Worth writing down, not worth
closing with a fake delay.

## Per-person allocation

Super-Admin-configurable, with a sane default (30 GB, or a share of the disk — a percentage ages
better across different boxes).

This is the part that changes `storage.ts` most, because eviction stops being one global LRU:

- Each device has a quota; its own items are evicted, oldest-accessed first, when it exceeds it.
- **A shared item is charged once, to its fetcher**, or the accounting can be gamed by sharing
  everything.
- **Last-access is the newest across all entitled devices**, so a copy somebody is still watching
  is not evicted because its original fetcher lost interest.
- The whole-disk budget still applies on top; a quota is a share of it, not a promise beyond it.

Open allocation is also what makes open pairing safe from the other direction: an unknown device
that joins can consume its quota and no more, so it cannot evict the household's library by filling
the cache.

## Protocol additions

| Where                            | Change                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `ItemMeta`                       | `visibility`, `entitled[]`                                                       |
| `GET /api/ping`                  | `unclaimed: true` while no admin exists, so the app can surface the claim button |
| `POST /api/pair`                 | no code; returns `pending` until an admin approves (or immediately when open)    |
| `POST /api/admin/claim`          | new — succeeds only while unclaimed                                              |
| `GET /api/admin/devices`         | new — pending and approved devices, with names                                   |
| `POST /api/admin/devices/{id}`   | new — approve, deny, revoke, set quota                                           |
| `POST /api/admin/settings`       | new — budget, TTLs, name, default quota, updater channel                         |
| `GET /api/catalog`               | entitlement-scoped; unfiltered branch removed                                    |
| `GET /stream/{infoHash}`         | authorise by entitlement; "not for you" == "not here"                            |
| `POST /api/items/{hash}/sharing` | new — visibility and entitled list, owner or admin only                          |
| `LanCacheStatusResponse`         | `isAdmin`, `quotaBytes`, `usedByMeBytes`; jobs gain an owner **name**            |
| `--claim-admin`                  | console flag, for recovery                                                       |

Device **names** are already collected at pairing (`tryPair(code, deviceName)`) and never surfaced.
Exposing them is what turns "share with specific people" into a checkbox list instead of a row of
hashes.

## Migration

Neither default is safe to apply quietly to items that predate the rule. Existing items become
`entitled: [ownerDeviceId]`, `visibility: 'private'`, and the app says once, plainly, that
previously-shared items are now private and can be re-shared. Items whose `ownerDeviceId` is unknown
— the pre-multi-user file `credentials.ts` already documents — become `shared`, because nobody can
be identified as their owner and stranding them where no one can reach them is worse.

Existing paired devices keep working and the first of them to open the app is offered the claim
button, so an upgrade does not lock anybody out of a daemon they already run.

## What this is not

Household courtesy with real API enforcement, not multi-tenant isolation. Visibility is a rule the
daemon applies, not encryption: anyone with shell access to the box reads everything. The device
identity is a bearer token — whoever holds it is that device. And with open pairing, anyone who can
reach the daemon can hold one, which is exactly why entitlement has to carry the weight the code
used to. Say all of this in the UI where somebody might otherwise assume otherwise.
