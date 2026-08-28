# r3-cache

The on-site pre-fetch daemon for the media hub — tier 2 of the playback
source order. It downloads the titles you plan to watch from TorBox ahead
of time onto a machine on your network, and serves them to the app over
the LAN, so a slow internet connection is paid once overnight instead of
at play time.

Zero-config: run it, read the 6-digit pairing code off its console, and
enter that in the app under **Settings → Cache server** (the app finds the
daemon by itself via mDNS; a manual URL field covers networks that filter
multicast). Everything it stores expires on its own — an idle TTL (14
days, refreshed by playing), a hard maximum age nothing survives (30
days), and a disk budget with LRU eviction.

## Running it

Development, from the repo:

```
npx tsx daemon/main.ts
```

Deployment builds two shapes:

```
npm run build:daemon        # -> dist-daemon/r3-cache.cjs (~60 KB, needs Node >= 20)
npm run build:daemon:sea    # -> + r3-cache-win-x64.exe / r3-cache-linux-x64
                            #      (self-contained, nothing to install)
```

Every Preview release of the app publishes both automatically (see
.github/workflows/preview.yml): the daemon ships from the same release
page, stamped with the same version, so the app can judge compatibility
from `/api/ping` and a future self-updater reads the feed the app's
updater already uses. For most people "install" is: download the
executable for your OS from the latest release, run it, pair.

Data lives in `%LOCALAPPDATA%\r3-cache` (Windows) or `~/.local/share/r3-cache`
(Linux); override with `R3_CACHE_DIR`. An optional `r3-cache.json` in that
directory overrides defaults (`port`, `diskBudgetGb`, `idleTtlDays`,
`hardMaxDays`, `serverName`) — it is never required.

### Linux, as a service (systemd user unit)

`~/.config/systemd/user/r3-cache.service`:

```ini
[Unit]
Description=r3-cache pre-fetch daemon
After=network.target

[Service]
Environment=R3_CACHE_DIR=%h/r3-cache/data
ExecStart=%h/r3-cache/node/bin/node %h/r3-cache/r3-cache.cjs
MemoryMax=512M
CPUWeight=20
Nice=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/r3-cache/data

[Install]
WantedBy=default.target
```

`systemctl --user enable --now r3-cache`, and `loginctl enable-linger $USER`
so it survives logout. The pairing code is in
`journalctl --user -u r3-cache -n 20`. On a box running anything
latency-sensitive, keep the resource caps — the daemon is built to lose
every contest for the machine.

### Windows, at login

```
schtasks /Create /TN r3-cache /SC ONLOGON /TR "node C:\path\to\r3-cache.cjs"
```

(or a shortcut in `shell:startup`). The pairing code prints in its console
window.

## Multiple people, one daemon

Each person pairs their own app and, via the checkbox, shares their own
TorBox key (a `0600` file per device — file permissions, not an OS
keychain). Every download is made with the account of **whoever asked for
that title** — the daemon never bills one household member for another's
watchlist. A job whose owner hasn't shared a key waits, and is adopted
automatically if someone who has shares wants the same title. Anything
cached is playable by every paired device — that sharing is the point of
an on-site cache. Unpairing revokes only your own key.

Auto-start and self-updating (with rollback so it always comes back
online) are planned but deliberately not built yet.

## Live verification

```
LANCACHE_URL=http://<host>:8945 LANCACHE_CODE=<console code> \
  npx tsx scripts/verify-lancache.ts
```

Checks discovery, identity, the auth boundary, pairing, catalog, Range
serving (206), and that the stream URL passes the app's own player gate.
