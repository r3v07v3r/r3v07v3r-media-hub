# r3-cache

The on-site pre-fetch daemon for R3 Media Hub, and tier 2 of its playback
source order. It downloads the next episodes of what people are watching
and what they plan to watch from TorBox ahead of time onto a machine on
your network, then serves them to the app over the LAN, so a slow internet
connection is paid once overnight instead of at play time.

Zero-config: run it, then join it from the app. The app finds the daemon
by itself over mDNS (a manual address field covers networks that filter
multicast); open the control centre, choose **Caching**, pick the server
and **Ask to join**. There is no pairing code. The first device to claim
the server becomes its administrator and approves everyone else from
their own app, or lets anyone on the network join without asking.
Everything the daemon stores expires on its own: an idle TTL (14 days,
refreshed by playing), a hard maximum age nothing survives (30 days), a
disk budget with LRU eviction, and a per-device allocation inside it.

## Running it

Development, from the repo:

```
npx tsx daemon/main.ts
```

Deployment builds two shapes:

```
npm run build:daemon        # -> dist-daemon/r3-cache.cjs (about 80 KB, needs Node >= 20)
npm run build:daemon:sea    # -> + r3-cache-win-x64.exe / r3-cache-linux-x64
                            #      (self-contained, nothing to install)
```

Every Preview release of the app publishes both automatically (see
`.github/workflows/preview.yml`): the daemon ships from the same release
page, stamped with the same version, so the app can judge compatibility
from `/api/ping`, and the daemon's own self-updater (below) follows the
same feed. For most people "install" is: download the executable for your
OS from the latest release, run it once with `--install`, then join it
from the app.

Data lives in `%LOCALAPPDATA%\r3-cache` (Windows) or
`~/.local/share/r3-cache` (Linux); override with `R3_CACHE_DIR`. An
optional `r3-cache.json` in that directory overrides defaults; it is never
required:

| Key             | Default                                            |
| --------------- | -------------------------------------------------- |
| `port`          | `8945`                                             |
| `diskBudgetGb`  | 80% of the free space at first start, capped at 50 |
| `idleTtlDays`   | `14`                                               |
| `hardMaxDays`   | `30`                                               |
| `tombstoneDays` | `60` (how long an evicted title is not re-queued)  |
| `serverName`    | the machine's hostname                             |
| `updateChannel` | `"preview"` (or `"stable"`)                        |
| `autoUpdate`    | `true`                                             |

Environment variables: `R3_CACHE_DIR` (the data directory), `R3_CACHE_NO_MDNS=1`
(do not announce over mDNS), `R3_CACHE_UPDATE_FEED` (a different release feed,
for testing the updater), and `XDG_DATA_HOME`, honoured for the default data
directory on Linux.

Command-line flags: `--install`, `--uninstall`, `--claim-admin` (lets the
next device to claim the server through, even though one already has: the
recovery for a lost administrator device) and `--version`.

### Linux, as a service

Prefer `r3-cache --install`. It writes
`~/.config/systemd/user/r3-cache.service`, runs `systemctl --user enable
--now r3-cache`, and turns on linger so the daemon survives logout. The
unit it writes has `Restart=always`, `RestartSec=5` and
`StartLimitIntervalSec=0`, which the rollback design depends on (a unit
that gives up is a daemon that is permanently offline), plus the resource
caps a shared box needs: `MemoryMax=512M`, `Nice=10`, `CPUWeight=20`,
`NoNewPrivileges=true`. The daemon is built to lose every contest for the
machine, so keep those caps on anything latency-sensitive.

If you write the unit by hand, keep `Restart=always` in it.
`journalctl --user -u r3-cache -n 20` shows the startup banner: server
name, port, disk budget and data directory. Until someone claims the
server from the app it also logs an UNCLAIMED reminder every five minutes.

### Windows, at login

Prefer `r3-cache --install`. It registers a per-user logon Scheduled Task
(no admin rights) and then adds a restart interval (`/RI 1 /DU 9999:59`) so
a daemon that stops comes back on its own and the launcher's rollback can
do its job. `ONLOGON` alone starts it once and never again, which is why a
hand-written `schtasks /Create ... /SC ONLOGON` is not enough on its own.
The console window shows the same banner as above.

## Who may use what

- **Joining.** A device asks to join from the app; the request waits until
  the administrator approves it, unless open join is switched on. There is
  nothing to type on either side. Asking is unauthenticated, so requests
  are throttled and the pending list is capped.
- **The administrator.** The first device to claim the server. From
  **Control centre → Caching** they approve, deny or revoke devices, set
  each device's disk allocation and the default allocation for new ones
  (a percentage of the budget), turn open join on or off, and can ask the
  daemon to check for an update now.
- **Private by default.** What one device fetches is visible only to that
  device until it shares the title with everyone or with named devices,
  from **What you have cached** in the same section. A second device that
  asks for the same title is added to the existing copy's entitled list
  rather than triggering a second download. `GET /api/catalog` requires a
  `keys` filter and only returns what the caller is entitled to;
  `/stream/{infoHash}` applies the same check.
- **Jobs are scoped, not annotated.** Each device sees its own queue and a
  count of everyone else's; the administrator sees them all.
- **Everyone pays for their own downloads.** Each person shares their own
  TorBox key from the app, kept in one `0600` `credentials.json` in the
  daemon's data directory, keyed by device (file permissions, not an OS
  keychain). A fetch is always made with the account of whoever asked for
  that title; the daemon never bills one household member for another's
  watchlist. A job whose owner has not shared a key waits, and is adopted
  if someone who has shared one wants the same title. Unpairing revokes
  only your own key.

The design is written up in [docs/CACHE-PERMISSIONS.md](../docs/CACHE-PERMISSIONS.md).

## What else it does

- **A household catalog.** The daemon crawls the title catalog (Cinemeta
  for movies and series, Kitsu for anime) once every six hours and serves
  it at `GET /api/titles`, paged by a change-sequence watermark, so paired
  devices sync the catalog from this box instead of each crawling it.
- **One relay connection per room.** When paired devices have Rooms open,
  the daemon holds a single upstream connection to the
  [R3 Party Sync](../party-sync-worker/README.md) relay per room and fans
  the traffic out locally (`roomsHop.ts`). It relays ciphertext only and
  never holds anyone's room credential.

## Auto-start, self-updating, rollback

`r3-cache --install` grants everything the daemon will ever need; after
this nobody goes back to it. Windows: a per-user logon Scheduled Task.
Linux: a systemd user unit, enabled, with linger. Everything else the
daemon does, updates included, happens inside the user's own directories,
so no elevation is requested again. `--uninstall` reverses it.

Updates are fully unattended. The daemon polls the app's GitHub release
feed (`updateChannel` in `r3-cache.json`, default `preview`), downloads
the new bundle plus its sha256, verifies it, and STAGES it under
`versions/<v>/`; running code is never touched. The restart that applies
it waits for a moment that interrupts nobody: never while a stream is
open, never within 30 minutes of one closing, and preferring the
household's historically quiet hours (a rolling hour-of-day histogram); an
update that has waited 24 hours applies at the first idle moment
regardless.

### What the update chain does and does not protect against

Written down because an adversarial review confirmed both, and a security
property nobody stated is a security property nobody can rely on:

- **Transport and integrity: covered.** Downloads are pinned to this
  repo's own release-download URLs (derived from the feed URL, so pin and
  feed cannot drift apart), https-only, every redirect hop re-validated,
  sizes capped while streaming, and the bundle checked against its
  published sha256. Arbitrary GitHub-hosted code, the
  `raw.githubusercontent.com/<anyone>/…` case, is refused at the entry
  point.
- **Publisher authenticity: NOT covered.** The sha256 is produced by the
  same CI job that builds the bundle and published beside it, so it
  detects corruption and enforces that both assets exist; it does not
  prove _who_ built the bundle. Anyone able to publish a release, or who
  compromises the CI token or the GitHub account, can ship code this
  daemon will install. Closing that needs a signature over the bundle
  verified against a public key embedded in the launcher; it is a
  deliberate gap, not an oversight.
- **Version labels are labels.** Updates must be strictly newer, which
  blocks a naive downgrade, but a feed-controlling attacker could relabel
  old vulnerable code with a higher version. Same root cause as the point
  above.

A launcher embedded in the executable makes bad updates self-healing: it
records a tripwire before booting any version, and a version that fails
to reach healthy twice is marked bad and never tried again. The daemon
falls back to the previous good version, or ultimately to the payload
compiled into the executable itself, which cannot be deleted. Rollback is
automatic and needs nobody's attention; `autoUpdate: false` in
`r3-cache.json` turns the whole mechanism off.

## Live verification

Two harnesses, for two different questions.

**Against a real daemon on a real LAN**: discovery over actual network
hardware, joining, Range serving, and the app's own player gate:

```
LANCACHE_URL=http://<host>:8945 npx tsx scripts/verify-lancache.ts
```

It asks to join under its own name and waits for you to approve
"verify-lancache harness" in **Control centre → Caching**;
`LANCACHE_TOKEN` reuses an approved pairing and skips the wait. The
byte-serving checks need one item in the cache that this device may read;
the script prints how to place one, and skips them rather than failing
when there is none. The media-server tier has a counterpart,
`scripts/verify-jellyfin.ts`, driven by `JELLYFIN_BASE_URL` and
`JELLYFIN_API_KEY`.

**The permission boundary, from an empty directory**: claiming, approval,
per-device scoping, and the refusal that must not be distinguishable from
absence:

```
npx tsx daemon/tests/permissions.e2e.ts
```

It boots its own daemon on port 8946 in a temporary directory and tears it
down again. Not part of `npm test`, because it binds a port. The daemon's
unit tests (`daemon/tests/*.test.ts`) are part of `npm test`, and
`npm run typecheck:daemon` type-checks this directory as its own project.

> Known gap (2026-09-27 audit): anime the daemon has pre-fetched is not
> yet served from the LAN tier, because the app's feeder and its stream
> resolver build the cache key differently for anime. Movies and series
> are unaffected. See [docs/AUDIT-2026-09-27.md](../docs/AUDIT-2026-09-27.md).
