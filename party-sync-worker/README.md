# R3-Party-Sync

Relay server for R3 Media Center's Watch Party **relay** mode. This is what
makes hosting a party work over the internet regardless of either side's
router — the app's own "direct" mode only works when UPnP or NAT-PMP
happens to succeed on the host's router (see the main app's
`src/main/media-hub/upnp.ts`), which many routers simply don't support.

This is **not bundled or auto-deployed** with the app — nothing is shared
between different installs of R3 Media Center unless you deploy this
yourself and everyone uses the same URL.

## What this costs

Cloudflare's Durable Objects (needed to coordinate multiple people's
WebSocket connections in one "room") require the **Workers Paid plan**,
currently **$5/month**. There's no way around this for a relay that needs
real shared state between connections — the free Workers tier doesn't
include Durable Objects at all.

## Deploy it

1. Sign up at [cloudflare.com](https://cloudflare.com) if you don't have an
   account, and upgrade to the Workers Paid plan (Dashboard → Workers &
   Pages → Plans).
2. From this folder:
   ```
   npm install
   npx wrangler login
   ```
3. Pick your own invite key — anyone who knows it can host a party on your
   Worker, so keep it private (a long random string is fine):
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
5. In R3 Media Center: **Settings → Watch Party** (or wherever
   R3-Party-Sync is configured), paste that URL and the same invite key you
   set in step 3.
6. Host a party with mode set to relay — everyone who joins your code now
   goes through this Worker instead of needing a direct connection to your
   PC.

## How it works (if you're curious / need to debug it)

- `POST /host` with `{"inviteKey": "..."}` creates a new room (a Durable
  Object, one per room) and returns a `roomId` + a `roomToken` that
  identifies whoever holds it as that room's host.
- Everyone connects to `wss://<your-worker>/party/<roomId>` — the host
  includes `?token=<roomToken>` from step above; everyone else connects
  with no token and is treated as a regular member.
- The server never decrypts anything. Every real message (who's in the
  party, what's playing, seek/pause, chat-like suggestions) is already
  encrypted end-to-end by the app itself before it ever reaches this
  Worker — this just tags each message with who sent it and relays it to
  everyone else in the same room. If you inspect traffic here, you'll only
  ever see opaque ciphertext, never plaintext party data.
- Rooms self-expire 24 hours after creation (see `alarm()` in `src/room.ts`)
  so idle rooms don't accumulate forever.

## Rooms membership (redeploy needed once)

The app's Rooms feature asks `/host` for `{"membership": true}`, which
adds a relay-level admission layer to that room: a `joinSecret` carried
in the invite code, per-install `memberKey`s, and a
`POST /party/{roomId}/kick` call the room's creator uses to remove
members (ban + disconnect + joinSecret rotation, atomically). The relay
still never decrypts anything — these are admission credentials, not
content.

Watch parties and rooms created before this behave exactly as before.
**A worker deployed before this feature simply ignores `membership`** —
rooms still work, but removing members does not until you redeploy:

```
cd party-sync-worker && npm run deploy
```

## Local testing

```
npm install
npx wrangler dev
```

Runs the Worker locally (with local Durable Object emulation) so you can
test the `/host` and `/party/:roomId` endpoints before deploying anything
real.
