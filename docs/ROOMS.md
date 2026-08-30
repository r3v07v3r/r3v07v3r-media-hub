# Rooms

What a room is, who its admin is, and — the part that must be written
before the code — exactly what removing a member does and does not
promise. This is the first social feature in the app where one person
can take something away from another, and a policy discovered afterwards
is a policy nobody agreed to.

## What a room is

A persistent, host-less presence channel on the party-sync relay: a
standing group — the family, the film friends — where members see who
has the app open and, per room and only by opt-in, what they are
watching. Joining a member syncs you to their playback without
interrupting them: your client asks, theirs silently opens a watch party
and answers with the code, and their playback never stops.

The relay stays a dumb forwarder. Every message is encrypted end-to-end
with the room secret before it leaves a device; the relay tags and fans
out ciphertext it cannot read. Everything below is built under that
constraint, and none of it weakens it.

## The admin

The room's creator, named in the invite code itself (`adminFriendId` in
the v3 share code). Members trust the code they joined with, so the
admin badge and the rename rule work offline, with no relay round-trip,
on any transport. The creator also holds two credentials nobody else
has:

- the relay **host token** from creating the room — the credential the
  relay's kick endpoint requires;
- the room's current **invite code**, which they re-issue after a kick.

A room whose creator predates admins (the migrated friends group, or one
joined by an old v2 code) simply has no admin. Nobody can rename it for
everyone, and nobody can kick from it. That is the truth of its history,
not a defect.

## Membership at the relay

A room created since kick existed carries a relay-level membership
layer. These are **relay credentials, not content** — the relay still
decrypts nothing:

- **memberKey** — a random identity each install generates per room,
  sent only on connect. It is a bearer credential — a known key is
  admitted without the current joinSecret — so it is a secret between
  one install and the relay, and never travels anywhere else. What
  presence announcements carry, and what a kick names, is its **sha256
  hash**: enough to ban by, useless to connect with. (An earlier draft
  broadcast the raw key; a kicked member who had cached a kept member's
  key could have walked straight back in as them.)
- **joinSecret** — the room's admission ticket, carried in the invite
  code. An install the relay has never seen must present the current
  joinSecret to be admitted; its memberKey is then registered.
- A **known, unbanned memberKey is always admitted**, even with a stale
  joinSecret — a family member whose laptop slept through a rotation is
  not locked out of their own room.
- A **banned memberKey is refused outright**, whatever it presents.

Rooms and parties created before this (or by older clients) have no
membership layer and behave exactly as before.

## What kicking a member actually does

The admin kicks a person, not a device: every identity hash their
announcements have EVER carried — the room keeps a bounded per-person
history precisely because presence ages out in seconds, and a kick must
reach the install the room saw last month, not just this minute. In
order — and the order is the guarantee:

1. The relay **bans** those memberKeys, **closes** their connections,
   and **rotates** the joinSecret — atomically, in one admin-authorised
   call.
2. Only then does the admin's client **rotate the room secret**,
   broadcasting the new secret and joinSecret to the room, encrypted
   under the old secret. The kicked member is already banned and
   disconnected: they cannot receive this message and cannot reconnect
   to fetch it.
3. The admin's invite code is re-issued with the new secret and
   joinSecret. The old code is dead for new joiners.

A member who was **offline during the kick** comes back, is admitted
(known memberKey), and announces under an old secret — possibly several
rotations old, so each member keeps a short bounded chain of previous
secrets rather than one. The admin answers in whichever old dialect the
returner actually spoke, handing them the current code — safe, because
the one party that must not hear it cannot connect. Nobody has to do
anything by hand. Someone offline through more rotations than the chain
keeps (five) needs the code re-shared once, which the admin always has.

## What it deliberately does not promise

Stated here so a green test suite is never read as more than it proves:

- **The kicked member keeps the old secret.** They can decrypt any
  traffic still encrypted with it — which, after step 2, is only the
  re-key hand-off to returning members, whose payload is the new secret
  they can no longer use and the new joinSecret the relay will refuse
  their banned key with.
- **A device of theirs the room never saw** (never announced, never
  connected) holds the old code: unknown memberKey + stale joinSecret →
  refused. But if it was _connected and silent_ at kick time under a
  memberKey no announcement ever carried, it keeps its connection until
  it drops and cannot rejoin after. Kick by person reaches the devices
  the room could see.
- **Within-room identity is honest, not enforced.** Anyone holding the
  room secret can claim any friendId in an announcement, including the
  admin's. Members are friends and family sharing a secret, and the
  admin badge and re-key messages are trust among them, not a boundary
  against them. The boundary against _outsiders_ is the secret itself;
  the boundary against _kicked members_ is the relay ban plus the
  rotation.
- **The relay operator sees the membership layer** (memberKeys,
  joinSecrets, who connects when) — it must, to enforce admission. It
  still cannot read a byte of what anyone says or watches.
- **The per-person identity history is bounded** (eight hashes per
  person). An install cycling fresh identities can shed its oldest from
  the history — but every shed identity was registered under a
  joinSecret that has rotated at each kick since, so what escapes the
  ban is a key that can no longer connect anyway.
- **A future cache-server hop** carries a household's traffic on one
  relay connection. Kicking one member of such a household bans their
  key and rotates the secrets — they can no longer read or be read — but
  their sends can still physically transit the household's shared
  connection as undecryptable noise until the household's own daemon
  drops them. Named here so it is a known trade, not a surprise.

## Room lifetime

A relay room is reclaimed after 30 days with nobody connected at all.
An always-on family room never reaches it; a fully abandoned room dies
with its code. That is the relay working as designed, not data loss.
