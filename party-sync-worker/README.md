# R3-Party-Sync

Relay server for R3 Media Hub's Watch Party **relay** route and the backbone
its Rooms run on. A Watch Party host always listens directly on its own
network and tries to map a router port (see `src/main/media-hub/upnp.ts` in
the app); this Worker is what makes a party joinable over the internet when
that mapping fails, which on many routers it does. Rooms — the standing
family or film-friends groups — exist only on the relay, so creating one
requires it.

This is **not bundled or auto-deployed** with the app. Nothing is shared
between different installs of R3 Media Hub unless you deploy this yourself
and everyone enters the same URL and invite key.

## What this costs

The relay keeps each room in a Durable Object with the SQLite storage
backend (`new_sqlite_classes` in `wrangler.toml`). Cloudflare includes
SQLite-backed Durable Objects in the Workers Free plan within that plan's
limits; the Workers Paid plan (currently $5/month) raises them. Rooms use
Durable Object hibernation, so a room that stays open for days is not
billed for duration the whole time: the object is evicted from memory
between messages and woken to handle one. Check Cloudflare's current
pricing page before relying on either plan.

## Deploy it

1. Sign up at [cloudflare.com](https://cloudflare.com) if you don't have an
   account.
2. From this folder:
   ```
   npm install
   npx wrangler login
   ```
3. Pick your own invite key — anyone who knows it can host a party or
   create a room on your Worker, so keep it private (a long random string
   is fine):
   ```
   npx wrangler secret put INVITE_KEY
   ```
   (paste your chosen key when prompted)
4. Deploy:
   ```
   npm run deploy
   ```
   Wrangler prints a URL like `https://r3-party-sync.<your-subdomain>.workers.dev`
   when it finishes.
5. In R3 Media Hub, open the control centre (the gear icon in the top bar),
   choose **Community**, and under **Watch Party relay** paste that URL and
   the same invite key you set in step 3, then connect.
6. Host a Watch Party as usual. The single invite code now carries the
   relay route as well as the direct one, and each guest's app uses the
   first route that answers. Rooms can now be created too.

## How it works (if you're curious / need to debug it)

- `POST /host` with `{"inviteKey": "..."}` creates a new room (one Durable
  Object per room) and returns a `roomId` plus a `roomToken` that identifies
  whoever holds it as that room's host. With `{"membership": true}` it also
  returns a `joinSecret` (see Rooms membership below).
- Everyone connects to `wss://<your-worker>/party/<roomId>` — the host with
  `?token=<roomToken>`, everyone else with no token as a regular member.
- On connect you get `{"type":"assigned","connId":"..."}` once, naming your
  own tag. You are then replayed each other member's last message, if it is
  under 10 minutes old, as `{"type":"retained","ageMs":...,"connId":...,
"isHost":...,"body":...}`; subtract `ageMs` before treating `body` as
  current.
- The server never decrypts anything. Every real message (who is in the
  party, what is playing, seek and pause, chat, suggestions) is encrypted
  end to end by the app before it reaches this Worker; the Worker tags each
  message with who sent it and relays it to everyone else in the room. If
  you inspect traffic here, you only ever see ciphertext.
- Limits: at most 32 connections per room (`Party is full.`, HTTP 429), at
  most 40 messages per connection per 10 seconds, and no message over 60 KiB;
  exceeding the last two closes that socket (codes 1008 and 1009).
- Rooms expire after 30 days with no activity (`ROOM_IDLE_TTL_MS`, `touch()`
  and `alarm()` in `src/room.ts`). Every `/init`, `/kick`, WebSocket connect
  and relayed message pushes the deadline out, and `alarm()` re-arms instead
  of deleting if anyone is still connected.

## Rooms membership

The app's Rooms feature asks `/host` for `{"membership": true}`, which adds
a relay-level admission layer to that room: a `joinSecret` carried in the
invite code, per-install member keys, and a `POST /party/{roomId}/kick` call
the room's creator uses to remove members (ban, disconnect and joinSecret
rotation, atomically). The relay still never decrypts anything — these are
admission credentials, not content.

A Worker deployed before this feature ignores `membership`: rooms still
work, but removing members does not until you redeploy:

```
cd party-sync-worker && npm run deploy
```

## Rooms hop (LAN daemon)

When an [r3-cache](../daemon/README.md) daemon runs on the household's LAN,
devices in the same room do not each open their own WebSocket to this
Worker. The daemon opens one upstream connection per room, presenting
itself with `?carrier=1`, and fans messages out to the local devices itself.
It relays ciphertext only and never holds anyone's room credential.

## Local testing

```
npm install
npx wrangler dev --var INVITE_KEY:some-test-key
```

Runs the Worker locally with local Durable Object emulation so you can test
`/host` and `/party/{roomId}` before deploying anything real. `/host` turns
away any request whose `inviteKey` does not match `INVITE_KEY`, so a plain
`npx wrangler dev` with no key refuses every `/host` call (a `.dev.vars`
file with `INVITE_KEY=...` works too). The WebSocket route only needs a room
that already exists.

CI (`.github/workflows/verify.yml`) typechecks this folder, runs
`npx wrangler deploy --dry-run`, and audits its production dependencies on
every pull request.
