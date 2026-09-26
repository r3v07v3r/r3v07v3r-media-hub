# R3-Party-Sync

Relay server for R3 Media Hub's Watch Party **relay** route and the backbone
its Rooms run on. A Watch Party host always listens directly on its own
network and tries to map a router port (see `src/main/media-hub/upnp.ts` in
the app); this Worker is what makes a party joinable over the internet when
that mapping fails, which on many routers it does. Rooms — the standing
family or film-friends groups — exist only on the relay, so creating one
requires it.

This is **not bundled or auto-deployed** with the app. Without it, Watch
Parties still work over the direct route (the same network, or a router
port the app managed to map), but Rooms cannot be created. Only the person
hosting a party or creating a room enters this Worker's URL and invite
key; guests and members get the relay route inside the invite code.

## What this costs

The relay keeps each room in a Durable Object with the SQLite storage
backend (`new_sqlite_classes` in `wrangler.toml`). At the time of writing
Cloudflare offers SQLite-backed Durable Objects on the Workers Free plan
within that plan's limits, and the Workers Paid plan (currently $5/month)
raises them; the comment in `wrangler.toml` that says Durable Objects need
the Paid plan predates that. Rooms use Durable Object hibernation, so a
room that stays open for days is not billed for duration the whole time:
while it is idle the runtime can evict the object from memory with the
sockets still open, and wakes it for the next message. Check Cloudflare's
current pricing page before relying on either plan.

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
6. Host a Watch Party as usual. If your app reached the Worker when the
   party started, the single invite code carries the relay route as well
   as the direct one. Each guest's app tries the direct route first (same
   network, then the mapped router port) and falls back to the relay when
   the host does not answer directly. Rooms can now be created too.

## How it works (if you're curious / need to debug it)

- `POST /host` with `{"inviteKey": "..."}` creates a new room (one Durable
  Object per room) and returns a `roomId` plus a `roomToken` that identifies
  whoever holds it as that room's host. With `{"membership": true}` it also
  returns a `joinSecret` (see Rooms membership below).
- Everyone connects to `wss://<your-worker>/party/<roomId>`, the host with
  `?token=<roomToken>`. In a Watch Party everyone else connects with no
  token. In a membership room every connection, the host's included, must
  also present a signed cryptogram (`pub`, `ts`, `ctr`, `sig`), plus
  `join=<joinSecret>` the first time an identity is seen (see Rooms
  membership below).
- On connect you get `{"type":"assigned","connId":"..."}` once, naming your
  own tag. You are then replayed each other member's last message, if it is
  under 10 minutes old, as `{"type":"retained","ageMs":...,"connId":...,
"isHost":...,"body":...}`; subtract `ageMs` before treating `body` as
  current. Then comes `{"type":"peers","connIds":[...]}`, listing every
  connection currently in the room.
- The server never decrypts anything. Every real message (who is in the
  party, what is playing, seek and pause, chat, suggestions) is encrypted
  end to end by the app before it reaches this Worker; the Worker tags each
  message with who sent it and relays it to everyone else in the room. Message bodies are always ciphertext. What the Worker does see in the
  clear is routing metadata (connection tags, host flags, the live peer
  list, banned identity hashes) and the admission credentials it checks:
  invite key, host token, join secret and signed cryptograms.
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

When a device is paired with an [r3-cache](../daemon/README.md) daemon on
the household's LAN, and that daemon offers the rooms hop, the device
subscribes to its rooms through the daemon instead of opening its own
WebSocket to this Worker. The daemon opens one upstream connection per
room (for a membership room it presents `?carrier=1` with the first
member's forwarded cryptogram) and fans messages out to the local devices
itself. It never holds the room's content key or anyone's private key; it
forwards members' single-use cryptograms and, for a first admission, the
room's join secret.

## Local testing

```
npm install
npx wrangler dev --var INVITE_KEY:some-test-key
```

Runs the Worker locally with local Durable Object emulation so you can test
`/host` and `/party/{roomId}` before deploying anything real. `/host` turns
away any request whose `inviteKey` does not match `INVITE_KEY`, so with a plain
`npx wrangler dev` and no key `/host` answers 403 and no room can ever be
created (a `.dev.vars` file with `INVITE_KEY=...` works too).

CI (`.github/workflows/verify.yml`, on every pull request and as the
preview/stable release gate) typechecks `src/`, runs
`npx wrangler deploy --dry-run`, and runs `npm audit --omit=dev`, which
only matters once the Worker gains a production dependency.
`tests/kick.e2e.ts` is manual: start
`npx wrangler dev --port 8788 --var INVITE_KEY:e2e-test-key` here, then run
`npx tsx party-sync-worker/tests/kick.e2e.ts` from the repo root.
