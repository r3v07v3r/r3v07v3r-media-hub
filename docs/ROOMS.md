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

## Identity: chip and tap

Every install holds an **Ed25519 private key that never leaves the
device** — the model is the one EMV bank cards use, and it was asked
for by that name. A member's id is the sha256 of their public key, so
**the identity is the key**: claiming an id without its private key is
impossible, because nothing you say verifies. There is no registry, no
first-use leap of faith, and no bearer string anywhere in the system —
three earlier drafts each patched a symptom of bearer credentials
(broadcast keys, harvestable household keys, self-declared hashes)
before this replaced the class.

**Every room message is signed by its sender, then encrypted.** The
relay and the cache hop still see only ciphertext; members see proof of
who spoke. The signature covers the room, a timestamp and a per-sender
sequence number, so a captured message cannot be replayed and a
signature made for one room means nothing in another. What used to be a
trust statement — "within-room identity is honest, not enforced" — is
now a property: **a member who leaks the room secret leaks words, never
a voice.** Renames and re-keys are believed only from the admin's
verified key, which travels in the invite code.

## Membership at the relay

Admission is a **cryptogram** — EMV's tap: a signature over this
relay's host, this room, the moment, and a strictly increasing counter
the relay remembers (the ATC). The relay verifies all four, so an
intercepted cryptogram is a receipt, not a card — bound to one door,
one moment, already spent. The relay still decrypts nothing.

- The **joinSecret** (in the invite code) is the invite's proof,
  required only of identities the room has never seen. It admits nobody
  by itself — possession proof is not optional.
- A **known, unbanned identity is always admitted on a fresh tap**,
  even with a stale joinSecret — a family member whose laptop slept
  through a rotation is not locked out of their own room.
- A **banned identity is refused outright**, whatever it presents.

Rooms and parties created before this (or by older clients) have no
membership layer and behave exactly as before.

## What kicking a member actually does

The admin kicks an identity — and the identity everyone sees, the
identity the relay admits, and the identity a kick names are now one
thing, so there is no history to reconstruct and no install the room
once saw that a kick could miss: every device of theirs speaks as that
id or not at all. In order — and the order is the guarantee:

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
(known identity, fresh tap), and announces under an old secret — possibly several
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
- **Within-room identity is now enforced, with one bound.** Nobody can
  speak as anyone else — every message verifies against its sender's
  key. What a member (or a leaked secret) still gets is READABILITY of
  traffic under that secret; identity and readability part ways, and
  the rotation after a kick ends even the readability.
- **Key loss is identity loss.** There is no recovery scheme: a device
  that loses its key is a stranger with a familiar name, and the admin
  re-invites it. Stated plainly rather than promising an account-reset
  flow this system deliberately does not have.
- **No forward secrecy per message.** A kicked member's already-read
  plaintext is theirs forever; ratcheting is out of scope for a
  household product, on purpose.
- **The relay operator sees the membership layer** (public keys,
  cryptograms, joinSecrets, who connects when) — it must, to enforce
  admission. It still cannot read a byte of what anyone says or
  watches, and nothing it sees lets it mint a tap.
- **The cache-server hop** carries a household's traffic on one relay
  connection — admitted on the first member's own tap, with every
  further member's tap handed up as a carry frame for the RELAY to
  verify. The daemon holds no credential of anyone's: it forwards
  cryptograms it cannot mint, exactly as a payment terminal forwards a
  card's tap to the bank. A relay ban still cannot close a kicked
  member's transport there, so three mechanisms together are the
  removal for hop members: the relay broadcasts each kick's banned
  identities and the daemon drops and refuses those subscribers —
  matched against relay-verified taps, not self-declared claims —
  before the re-key can pass; re-keys are sent transient, never
  retained; and the admin's client refuses presence and rescues to
  kicked ids outright. What remains for a MODIFIED client behind a hop:
  it can subscribe under a second identity it minted while it held a
  valid invite and keep receiving ciphertext it can no longer read —
  noise in, nothing out.

## Room lifetime

A relay room is reclaimed after 30 days with nobody connected at all.
An always-on family room never reaches it; a fully abandoned room dies
with its code. That is the relay working as designed, not data loss.
