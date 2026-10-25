# r3-cache

The on-site pre-fetch daemon for R3 Media Hub, and tier 2 of its playback
source order. It downloads the next episodes of what people are watching
and what they plan to watch from TorBox ahead of time onto a machine on
your network, then serves them to the app over the LAN, so a slow internet
connection is paid once overnight instead of at play time.

Zero-config: run it, then start the app. A few seconds after launch the app
looks for the daemon over mDNS, falls back to asking every address on its
own subnet for `/api/ping` on port 8945 when multicast is filtered, and asks
to join the first one it finds. Nobody types an address, and nothing is tied
to a particular range. The first device to claim the server becomes its
administrator. Every later request raises a toast in the administrator's app
("… wants to use r3-host. Allow it?") with **Allow** and **Deny**, plus a
desktop notification when the app is not in front; with open join switched
on, devices are let in with no prompt. If the server's address changes, the
app finds the same server again (same name, and it still recognises this
device's token) and updates the stored address. **Leave** stops the launch
search until you join by hand again. The manual address field under
**Control centre → Caching** is still there as an override; a typed address
is replaced only once it has stopped answering and the same server has been
found elsewhere. There is no pairing code.

Every title the daemon downloads leaves on its own: it expires after an idle
TTL (14 days, refreshed by playing) or a hard maximum age (30 days, deferred
only while someone is actually streaming the file), and is removed to make
room under a disk budget with LRU eviction and a per-device allocation inside
it. Pairings, shared TorBox keys, administrator settings and the household
catalog do not expire; how a device and its key are removed is under
[Who may use what](#who-may-use-what).

## Running it

Development, from the repo:

```
npx tsx daemon/main.ts
```

Deployment builds two shapes:

```
npm run build:daemon        # -> dist-daemon/r3-cache.cjs (a few hundred KB, needs Node >= 20)
npm run build:daemon:sea    # -> + r3-cache-win-x64.exe / r3-cache-linux-x64
                            #      (self-contained, nothing to install)
```

Every Preview release of the app publishes both automatically (see
`.github/workflows/preview.yml`): the daemon ships from the same release
page, stamped with the same version as the app, and the daemon's own
self-updater (below) follows the same feed. The app works out what a server
supports from the fields it answers with, not from that version number.

For most people "install" is: download the executable for your OS from the
latest Preview release (stable releases carry no daemon files), run it once
with `--install`, then join it from the app. On Windows the task first
starts at your next logon, so run the executable once by hand (or sign out
and back in) before joining.

Data lives in `%LOCALAPPDATA%\r3-cache` (Windows) or
`$XDG_DATA_HOME/r3-cache`, normally `~/.local/share/r3-cache` (Linux);
override with `R3_CACHE_DIR`. An
optional `r3-cache.json` in that directory overrides defaults; it is never
required:

| Key             | Default                                                         |
| --------------- | --------------------------------------------------------------- |
| `port`          | `8945`                                                          |
| `diskBudgetGb`  | 80% of the free space each time the daemon starts, capped at 50 |
| `idleTtlDays`   | `14`                                                            |
| `hardMaxDays`   | `30`                                                            |
| `tombstoneDays` | `60` (how long an expired title is not queued again)            |
| `serverName`    | the machine's hostname                                          |
| `updateChannel` | `"preview"` (`"stable"` is accepted but never finds an update)  |
| `autoUpdate`    | `true`                                                          |

A title removed to make room, or removed by hand from **What you have
cached**, is not held back and can be queued again straight away.

Environment variables: `R3_CACHE_DIR` (the data directory), `R3_CACHE_NO_MDNS=1`
(do not announce over mDNS), `R3_CACHE_UPDATE_FEED` (a different release feed,
for testing the updater), and `XDG_DATA_HOME`, honoured for the default data
directory on Linux.

Command-line flags: `--install`, `--uninstall`, `--claim-admin` and
`--version`.

`--claim-admin` is the recovery for a lost administrator device, or for an
administrator who chose **Leave**:

1. Run `r3-cache --claim-admin`. It writes a flag to the data directory and
   exits; you do not need to stop the daemon first, but it only reads the
   flag when it starts. Until another device claims the server, the old
   administrator device keeps the role.
2. Restart the daemon:
   - Linux: `systemctl --user restart r3-cache`.
   - Windows: close the r3-cache console window, then run
     `schtasks /Run /TN r3-cache` (or the executable, if you never ran
     `--install`). After a logon you can also just wait: the task's restart
     interval, under [Windows, at login](#windows-at-login), brings the
     daemon back within a minute. Do not start the executable by hand while
     that interval runs: the task then starts another copy every minute,
     and each copy that finds the port taken counts as a failed boot of the
     running version, so within minutes a version the daemon updated itself
     to is marked bad.
3. In the app, open **Control centre → Caching** and choose **Administer
   it**. The button shows only on a device that has joined: on one that has
   not (the administrator that chose **Leave**, or a new device), choose
   **Ask to join** first, and on one still waiting to join, choose
   **Cancel** and then **Ask to join**. Only a request made after the
   restart is let in at once.

If the app answers "Too many devices are waiting to join", wait a minute and
ask again. If it still says so, eight requests are already waiting (every
**Cancel** leaves its request behind on the server), and with the
administrator gone nobody can deny them. Delete the entries with
`"status":"pending"` from `auth.json` in the data directory, then restart
the daemon as in step 2 and ask once more. The daemon reads `auth.json` only
when it starts, and while eight requests are waiting it does not rewrite
the file, so you can make the edit while it runs.

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
(intended to need no admin rights; if `schtasks` answers "Access is
denied", run it once from an elevated prompt) and then adds a restart interval (`/RI 1 /DU 9999:59`) so
a daemon that stops comes back on its own and the launcher's rollback can
do its job. `ONLOGON` alone starts it once and never again, which is why a
hand-written `schtasks /Create ... /SC ONLOGON` is not enough on its own.
The console window shows the same banner as above.

## Who may use what

- **Joining.** A device asks to join from the app, and the request waits
  until the administrator approves it. It is let in at once when open join
  is switched on, or while the server reports itself unclaimed (it has no
  administrator yet, or `--claim-admin` has reopened it), since then any
  device could claim the server outright anyway. There is nothing to type
  on either side. Asking is unauthenticated, so requests are throttled and
  the pending list is capped.
- **The administrator.** The first device to claim the server. From
  **Control centre → Caching** they **Approve** or **Deny** devices that
  ask, **Remove** approved ones (which withdraws that device's TorBox key
  and cancels its jobs), set each device's disk allocation and a default
  allocation (a percentage of the budget), turn open join on or off, and
  use **Update now** (see
  [Auto-start, self-updating, rollback](#auto-start-self-updating-rollback)).
  The default allocation applies to every approved device that has no
  allocation of its own, including devices that joined before it was set.
- **Private by default.** What one device fetches is visible only to that
  device until it shares the title with everyone, using the switch in
  **What you have cached** in the same section (the daemon's sharing API can
  also name individual devices; the app does not offer that yet). A second
  device that asks for the same release (the same torrent) once it is fully
  cached is added to that copy's entitled list rather than triggering a
  second download. `GET /api/catalog` requires a `keys` filter and only
  lists cached items the caller is entitled to (in-flight and tombstone
  state are still reported for any key named); `/stream/{infoHash}` applies
  the same entitlement check.
- **Jobs are scoped.** Each device sees its own queue and a count of
  everyone else's; the administrator sees the whole queue with each job's
  device name.
- **Everyone pays for their own downloads.** Each person shares their own
  TorBox key from the app, kept in one `0600` `credentials.json` in the
  daemon's data directory, keyed by device (file permissions, not an OS
  keychain). A fetch is always made with the account of whoever asked for
  that title; the daemon never bills one household member for another's
  watchlist. A job whose owner has not shared a key waits; if anyone else
  asks for the same title while it is still queued, the job becomes theirs
  and is fetched with their key.
- **Leaving.** **Leave** in the app forgets the server on this device and,
  if the server answers at that moment, withdraws your TorBox key. The
  device stays in the administrator's list, with any key the server did not
  hear withdrawn, until the administrator removes it. Leaving does not hand
  on the administrator role, and coming back counts as a new device, so an
  administrator who leaves cannot take the role back from the app;
  `--claim-admin` (under [Running it](#running-it)) is the way back.

The design is written up in [docs/CACHE-PERMISSIONS.md](../docs/CACHE-PERMISSIONS.md).

## What else it does

- **A household catalog.** The daemon crawls the title catalog (Cinemeta
  for movies and series, Kitsu for anime) once every six hours and serves
  it at `GET /api/titles`, paged by a change-sequence watermark, so paired
  devices get the full-depth catalog from this box instead of each crawling
  it to depth (the short trending crawl still runs locally).
- **One relay connection per room.** When paired devices have Rooms open,
  the daemon holds a single upstream connection to the
  [R3 Party Sync](../party-sync-worker/README.md) relay per room and fans
  the traffic out locally (`roomsHop.ts`). It relays ciphertext only and
  never sees the room's encryption key. Every device hands it the room's
  join secret when it subscribes, so whoever controls the daemon could join
  the room as a silent member that reads only ciphertext; see
  [Rooms hop](../party-sync-worker/README.md#rooms-hop-lan-daemon).

## Auto-start, self-updating, rollback

`r3-cache --install` grants everything the daemon will ever need; after
this nobody goes back to it. Windows: a per-user logon Scheduled Task.
Linux: a systemd user unit, enabled, with linger. Everything else the
daemon does, updates included, happens inside the user's own directories,
so no elevation is requested again. `--uninstall` removes the task or
unit (on Linux, linger stays on; `loginctl disable-linger` turns it off).

Updates are fully unattended. The daemon polls the app's GitHub release
feed (`updateChannel` in `r3-cache.json`, default `preview`), downloads
the new bundle plus its sha256, verifies it, and STAGES it under
`versions/<v>/`; running code is never touched. The restart that applies
it waits for a moment that interrupts nobody: never while a stream is
open, never within 30 minutes of one closing, and preferring the
household's historically quiet hours (a rolling hour-of-day histogram); an
update that has waited 24 hours applies at the first idle moment
regardless. The administrator's **Update now** checks the feed first, then
skips the half-hour wait and the quiet hours, but still never interrupts
an open stream. It does nothing while `autoUpdate` is `false`.

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
records a tripwire before booting any version, and a version that twice
fails to boot, or dies within ten minutes of reporting healthy, is marked
bad and never tried again. The daemon falls back to the newest staged
version not marked bad, or ultimately to the payload compiled into the
executable itself, which cannot be deleted. Rollback is automatic and
needs nobody's attention. `autoUpdate: false` in `r3-cache.json` stops
the daemon checking for and staging updates; the launcher still boots
whatever is already staged and still rolls back a bad one.

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
