# r3-cache permissions — design

Agreed 2026-08-29. **Built 2026-08-29**, in the order this document
mandates: entitlement, the administrator claim, device approval, per-device
allocation, then — and only then — the removal of the pairing code.

What was built departs from the plan below in these ways.

Deliberate, and documented in the code where they happen:

- **The job list is scoped for devices and annotated only for the
  administrator.** This document called for jobs to gain an owner name.
  `/api/status` already handed every paired device the TITLES of everything
  the household was fetching — the same read-side hole entitlement closes on
  the catalog, sitting on the queue instead of the disk — so adding names
  would have widened it from "what does this household watch" to "who
  watches what". A device sees its own queue and a count of everyone else's.
  The administrator sees the whole queue with each job's owner name, because
  a queue that cannot say whose a title is cannot answer the first question
  an administrator has about their own disk.
- **The join request is throttled and the pending queue is capped.** The
  six-digit code was brute-forceable, so attempts were rate-limited. Asking
  to join is not a guess, so there is nothing to brute-force — but the
  request is now unauthenticated, and without a bound anyone on the network
  could fill an administrator's approval list and the daemon's auth.json.

Not built as planned:

- **No default allocation.** Nobody has a quota until the administrator sets
  a default share or gives a device its own figure (see Per-person
  allocation).
- **The administrator does not set the disk budget.** The budget, the TTLs
  and the server name come from the config file at start-up; the
  administrator sets only open join and the default share.
- **The app shares with everyone or no one.** The sharing route still
  accepts a list of named devices, but the app offers only a private/shared
  switch.
- **The migration notice is in the daemon log only** (see Migration).
- **The app does not state the limits** (see Known limits).

The original requirements:

1. **No pairing code.** Reading a 6-digit code off `journalctl` is the worst step in the product.
2. What a person caches is **private by default** — shareable with everyone, or with named people.
3. A **Super Admin** (called the administrator in what was built), claimed with a button by the
   first person to connect, who configures sharing, the disk budget, and each person's allocation.
4. Everyone else pairs freely and gets a reasonable default allocation.

Requirements 1 and 2 are **one decision, not two**, and the order matters — see below.

## What was true before the build

**Already correct.** Credentials were per device (`credentials.ts` keyed TorBox tokens by
`deviceIdForToken`, a hash of the bearer token) and every job recorded `ownerDeviceId`, so **a fetch
only ever billed its own owner's account, never a housemate's**. `server.ts` already computed
`callerDeviceId` on every authenticated route.

**The key rule now.** Each person's TorBox key is saved on the cache and used only for their own
requests. The app saves it whenever it joins, by hand or by the launch search (the Join panel's
consent box is ticked by default), if it holds a key then (with none it sends nothing, and keeps
the consent so a key saved later follows), saves it again when the key changes in the app, and removes it
when the key is removed. `POST /api/jobs` refuses a device with no saved key with 403
`torbox-key-required` and queues nothing for it, so its request can never be fetched with another
person's key. The check comes after the dedupe: a file already cached is still granted to that
device, and a download already under way is answered with its state. The app tells the person once
and falls back to its other tiers.

**The hole.** Nothing used it for reading. `GET /api/catalog` with no `keys` filter returned **every
cached item, with titles, to any paired device**, and `GET /stream/{infoHash}` authorised on "is
this token paired" rather than on who owned the item. Ownership was enforced for _spending_ and
ignored for _seeing_.

**And the useful discovery: the app never asked for the unfiltered listing.** `lanCacheFeeder.ts`
always called `lanCacheCatalog(wanted.map(e => e.contentKey))` with keys derived from its own
watchlist, and resolve asked about exactly one key. The unfiltered branch of `/api/catalog` was dead
weight for the product and existed only as a leak. It could be deleted rather than fixed.

## Dropping the pairing code

The code is a real usability failure and removing it is the right call — **but it is only safe
because private-by-default lands at the same time, and it must not ship before it.**

Before entitlement, "paired" meant "may stream everything". Remove the code from _that_ and anyone
on the LAN can watch the whole cache. Once entitlement is enforced, pairing buys almost nothing on
its own: a new device can see its own items, spend its own TorBox token, and use its own
allocation. That is what makes open pairing reasonable, so the build order is not negotiable —
**entitlement first, then remove the code.**

### What replaces it, keeping zero friction

**In-app approval, not a code.** After an administrator exists, a new device pairing appears in the
administrator's app as a request — device name, LAN address, time — with Allow and Deny. That is
strictly better UX than reading a console: nothing to type, nothing to transcribe, and the
administrator sees who is asking instead of handing out a secret that any recipient can reuse.

Optionally an administrator's "let anyone on this network join" switch, for a household that
genuinely does not want to be asked. That is the user's original proposal, kept as a deliberate
choice rather than the unavoidable default.

### Claiming the administrator role

The button is right. The bound is what needs care: **pure first-come leaves an unclaimed headless
daemon open to whoever finds it first**, and this daemon is advertised over mDNS and designed to
run at boot on a box nobody looks at. A week later the first person to open the app is not
necessarily the installer.

So: **claimable while unclaimed, and the daemon says loudly that it is unclaimed** — a console
banner every few minutes and, more usefully, an `unclaimed: true` flag on `/api/ping` so any app
that discovers it can offer the button prominently. The realistic exposure is then the minutes
between installing the daemon and opening the app, which is the same window a printed code had
anyway, without the typing.

For the paranoid case and for recovery: `--claim-admin` on the console writes a flag that reopens
claiming the next time the daemon starts, and exits without starting the server (see Known limits
for what that window allows; the recovery steps are in
[daemon/README.md](../daemon/README.md#running-it)). The console stays the root of trust — not
because people should have to use it, but because on a box you physically control it is the only
thing that cannot be taken from you remotely.

**The administrator manages the service, not other people's libraries.** They also have a shell on
that box and can read every file, so an interface claiming otherwise would be lying. The
administrator gets the join settings, aggregate usage, the device list, the whole job queue with
owner names, and "Update now". Approving a device lends it nothing: it fetches with its own TorBox
key, never the administrator's. They can revoke a device, which also forgets its TorBox token and
cancels its jobs but keeps the items it already fetched. They can cancel any job, and remove or
change the sharing of any item they can name by its hash. The administrator does not get a "browse
everyone's items" screen: no route lists another device's items.

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
their own account regardless. Changing who is entitled never deletes the file: the owner always
stays entitled, and a copy leaves the disk only through eviction or when its owner or the
administrator removes it.

**The residual leak, named honestly:** B learns from the speed that the file was already there. A
weak side channel, and the price of a shared cache being shared. Worth writing down, not worth
closing with a fake delay.

## Per-person allocation

Set by the administrator. There is no allocation until the administrator sets one: they can give
every device a default share of the disk budget as a whole percentage (0-100), and give a single
device its own figure in bytes. A device with neither is bounded only by the whole-disk budget.

This is the part that changes `storage.ts` most, because eviction stops being one global LRU:

- A device with a quota has its own items evicted, oldest-accessed first, when it goes over it.
- **A shared item is charged once, to its fetcher**, or the accounting can be gamed by sharing
  everything.
- **Last-access is the newest across all entitled devices**, so a copy somebody is still watching
  is not evicted because its original fetcher lost interest.
- The whole-disk budget still applies on top; a quota is a share of it, not a promise beyond it.

A default share is also what makes open pairing safe from the other direction: once the
administrator has set a default share, a device that joins can consume that share and no more. A
per-device figure cannot do this, because it can only be set on a device that has already joined.
Until a default is set, no device has a quota unless it has been given its own figure, the
whole-disk budget evicts the least recently watched items whoever owns them, and a newly joined
device can push the household's library out by filling the cache. Items of a device that is no
longer paired have no quota either and are bounded by the budget alone.

## Protocol additions

| Where                            | Change                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ItemMeta`                       | `visibility`, `entitled[]`                                                                                                                                                                                         |
| `GET /api/ping`                  | `unclaimed: true` while no administrator exists, so the app can surface the claim button                                                                                                                           |
| `POST /api/pair`                 | no code; `pending` until the administrator approves; approved at once when join is open, nobody administers the server, or claiming is reopened; 429 when throttled (10 a minute) or 8 devices are already waiting |
| `POST /api/admin/claim`          | new — succeeds only while unclaimed                                                                                                                                                                                |
| `GET /api/admin/devices`         | new — pending and approved devices, with names                                                                                                                                                                     |
| `POST /api/admin/devices/{id}`   | new — approve, deny, revoke, set quota                                                                                                                                                                             |
| `POST /api/admin/settings`       | new — open join and the default quota percentage only; budget, TTLs and name come from the config file at start-up                                                                                                 |
| `POST /api/admin/update`         | new — administrator only; checks for an update now and installs it once no stream is open                                                                                                                          |
| `GET /api/catalog`               | entitlement-scoped; unfiltered branch removed                                                                                                                                                                      |
| `GET /stream/{infoHash}`         | authorise by entitlement; "not for you" == "not here"                                                                                                                                                              |
| `POST /api/items/{hash}/sharing` | new — visibility and entitled list, owner or administrator only                                                                                                                                                    |
| `LanCacheStatusResponse`         | `isAdmin`, `quotaBytes`, `usedByMeBytes`; jobs scoped to the caller plus a count of others; the administrator gets the whole queue with owner names                                                                |
| `--claim-admin`                  | console flag, for recovery                                                                                                                                                                                         |

Device **names** are what a device sends when it asks to join, cut to 64 characters ("unnamed
device" when it sends none). The administrator sees them in the device list and against each job in
the queue. The app does not use them to share with specific people (see the departures at the top).

## Migration

Neither default is safe to apply quietly to items that predate the rule. Existing items become
`entitled: [ownerDeviceId]`, `visibility: 'private'`, and the daemon says so once in its log at
start-up, with how many items it marked and that they can be re-shared from the app. Items whose
`ownerDeviceId` is unknown — the pre-multi-user file `credentials.ts` already documents — become
`shared`, because nobody can be identified as their owner and stranding them where no one can
reach them is worse.

Existing paired devices keep working and the first of them to open the app is offered the claim
button, so an upgrade does not lock anybody out of a daemon they already run.

## What this is not

Household courtesy with real API enforcement, not multi-tenant isolation. Visibility is a rule the
daemon applies, not encryption: anyone with shell access to the box reads everything. The device
identity is a bearer token — whoever holds it is that device. And with open pairing, anyone who can
reach the daemon can hold one, which is exactly why entitlement has to carry the weight the code
used to.

## Known limits

`GET /api/catalog?keys=…` scopes `items` to what the caller is entitled to, but `inFlight` and
`tombstoned` still answer for any key the caller names, whoever queued it. A device can therefore
learn that a title it names is being fetched right now or was recently expired, though not by whom.
This is left open on purpose, because those two lists steer the app's feeder rather than just
describe the cache: a feeder that stopped seeing a housemate's queued job would queue the same title
again on every pass (the job store keeps the first owner, so that request joins the job rather than
taking it over; a queued job moves only when its owner has removed its TorBox key and the newcomer
has); and tombstones record no owner at all, so hiding them would let every other device re-fetch a
title the TTL just expired. Filtering the response would not close it on its own either:
`POST /api/jobs` answers with the state of the job a caller joins, so the same fact is one request
away.

While `--claim-admin` has reopened claiming, `/api/ping` reports the server as unclaimed and every
device that asks to join is let in without asking; the daemon logs each one by name so whoever is
recovering the box can see who joined. A claim by the current administrator succeeds but does not
close that window, and the log says so; a claim by another device does. The current administrator
can also close it without handing the role on: the app's **Administer it** button does so straight
after its claim, and **Close claim window** in the Caching section calls the admin-only
`POST /api/admin/close-claim` (backed by `admin.closeReopen()`), which ends the reopening, persists
it and logs it. The app never closes it from its background poll, because the owner may have
reopened claiming on purpose to hand the role to another device.

The Caching panel says only that shared items can be streamed by anyone who has joined and private
ones only by you. It does not tell people that visibility is a rule rather than encryption, that
shell access on the box reads everything, or that a device's identity is a bearer token.
