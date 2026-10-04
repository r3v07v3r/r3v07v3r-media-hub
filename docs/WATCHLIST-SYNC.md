# Two-way watchlist sync

The rules this app follows when your plan-to-watch list exists in more
than one place. Written before the code, because this is the first sync
in the app that can **delete** something somebody meant to keep, and a
policy discovered afterwards is a policy nobody agreed to.

Services in scope: **Simkl**, **Trakt**, **MyAnimeList**. Kitsu has no
account here and cannot participate.

## The problem two-way sync actually has

One-way pulling is safe because it only ever adds. The moment removals
propagate, every sync has to answer a question with no obviously right
answer: **a title is on the local list and not on Trakt — which of those
is the change?**

It could be:

1. You added it here, and Trakt has not heard yet. → push it to Trakt.
2. You removed it on Trakt, and this app has not heard yet. → remove it
   here.

The states are identical. Nothing in a snapshot distinguishes them, and
guessing wrong either resurrects something you deleted or deletes
something you added. Every rule below exists to make that question
answerable rather than guessed.

## The rules

### 1. Adds propagate both ways, always

Marking Plan to Watch here pushes to every connected service. A title
appearing on any service's list is added here. Adds are safe: the worst
case is a title on a list you did not put it on, which is one click to
undo and loses nothing.

### 2. A removal only propagates if this app SAW the thing arrive

The app records where each planned title came from — `planned:origins`,
written when a pull adds a title, holding the service, the time, and
**which account** (rule 7).

- A title with a recorded remote origin, now absent from every remote
  list, **is removed locally**. This app watched it arrive from Trakt and
  now watches it leave; that is case 2 above, established rather than
  inferred.
- A title with **no** recorded remote origin is never removed by a pull,
  however long it has been absent from every service. It was added here.
  That is case 1, and the answer is to push it, not to delete it.

This is the whole safety property. A first sync against an account you
have never pulled from cannot delete anything, because nothing has an
origin yet.

One more condition holds a removal back even with an origin: **a title
that has been started here is never removed by a pull.** Leaving plan to
watch at a service is what starting a show looks like there. Simkl moves
it to "watching" on the first episode, MAL on the first progress push, so
a series that was planned at a service and then watched is absent from
that service's plan list without anybody having removed it. Read as a
removal, it would untrack the show and drop it out of Continue Watching.
"Started" means a viewing recorded under the title, or under the show a
merged anime season belongs to. Films are not in this set: a film watched
leaves the plan by rule 8, not by a pull.

### 3. A local removal is only sent where it cannot do collateral damage

Un-planning here removes the title from the services that have it. What
"have it" has to mean depends on the service, because their removal calls
are not equally narrow:

- **Trakt and MAL are scoped.** Trakt's remove targets the watchlist
  itself; MAL's deletes a list entry and only after checking its status is
  still plan_to_watch. Asking either to remove something it does not have
  removes nothing and touches no other record, so no evidence is needed.
- **Simkl is not.** Its documented removal is `/sync/history/remove` — the
  same endpoint that un-watches — because a title's list membership and
  its watched state are one record there. Sent for a title Simkl never had
  on the watchlist, it does not fail harmlessly: it erases whatever watch
  history that account had for the title.

So an unscoped removal is sent **only** where this app's last pull
actually found the title. No evidence, no request. Being wrong that way
leaves a stale row on somebody's list, which they can delete; being wrong
the other way destroys history nobody can get back.

Evidence is necessary but not always enough: **the unscoped removal is
never sent for a show with viewings recorded here.** Simkl's request there
is a bare show reference, which erases the show's whole history, including
episodes watched elsewhere. Taking a half-watched show off the list here
means "stop showing me this", not "forget I watched it"; rule 8 says the
same about a title marked watched. The same holds when a queued removal is
retried after the show was started: a removal owed only to Simkl then
sends nothing and is dropped as settled. Trakt and MAL are unaffected.

### 4. Local always wins a genuine conflict

If a title is both locally removed and remotely re-added between two
syncs, the local removal wins and is re-pushed. You are sitting in front
of this app; the other service is not asking.

### 5. Nothing is deleted on a failed or partial pull

If a service errors, its titles are not treated as absent. Absence has to
be a **successful** answer that did not contain the title, not the
absence of an answer. A network outage must never read as "the user
emptied their watchlist" — this is the same refusal that keeps the
source tags when every service fails.

The corollary matters just as much and is easier to get wrong: **an empty
answer is a real answer.** Somebody whose last remotely-planned title has
just been removed gets an empty list back from every service, and that is
the most ordinary removal there is. "Nothing came back" therefore has to
be split into "nothing answered" (do nothing) and "everything answered,
with nothing in it" (a removal), or the one case this half exists for is
the one case it never handles.

**A list that was not read has not answered either.** The background pull
leaves Simkl's lists unread when Simkl says nothing has changed (see "When
Simkl's lists are read", below). Simkl then counts exactly as a service
that errored: it is not evidence this pass, no title that came from it can
be removed, and the tags its last real read left behind are carried over,
where they can only hold a removal back. It is never counted as having
answered with an empty list, which would remove every title this app ever
pulled from it.

### 6. A removal that has not landed yet suppresses its own undo

A delete a service rejects is queued — `planned:pending-removals` — and
retried at the start of each sync, asking only the services that still
owe one.

While it is queued, **the pull will not add that title back.** Without
that, a failed removal quietly reverses itself: the title is gone here,
the next pull still finds it there, and the add loop restores it with
nothing to say that anything went wrong.

After ten attempts the entry is dropped and a later pull may re-add the
title. That is not giving up on the person's decision; it is the truth of
the situation — the title really is still on their list at the service,
and the app pretending otherwise would hide the failure rather than fix
it.

The same queue holds an **add** a service refused. Rule 1 says adds
propagate always, and before this an add that failed simply did not —
there was nothing to try again. A queued add is retried on the same
schedule, and once it lands it counts as evidence of presence (rule 3)
exactly as an add that succeeded first time would. A queued add never
suppresses anything: the title is on the local list already, and a pull
that finds it at a service that did take it is free to record that.

Changes to one title are applied in the order they were made. A plan
followed by an un-plan before the first push has settled waits for it, so
the removal sees what the add achieved rather than a record it had not
reached yet.

Plan changes share that per-title chain with watch-history pushes and
scrobbles (`src/main/media-hub/titlePushQueue.ts`), so the un-plan that
marking a title watched triggers, and a re-plan that undoes it, cannot
overtake each other or the history push.

### 7. Everything remembered is stamped with the account it came from

"It came from Trakt" is not a fact about a list, because Trakt is not one
person. Authorize a different account and its watchlist is a successful
answer that does not contain the previous account's titles — exactly the
shape rule 2 looks for, and the wrong conclusion entirely.

So every persisted record here — origins, source tags, queued removals,
and the cached custom lists — carries a mark identifying the connection it
was made under (`settingsStore`'s account marks, which explain why this is
a stamp rather than a clear-on-sign-out). A record whose stamp does not
match the account connected now is inert: its tags are not shown, its
origin justifies no deletion, its queued removal is never sent. Records
written before stamps existed name no account and are treated the same
way — unattributable, and therefore safe.

### 8. Marking a planned title watched takes it off the plan — without a removal

The app has one status per title: not watched, plan to watch, watched.
Marking a planned title watched (a film, or every aired episode of a
show) drops it from the local plan. That is NOT rule 3's removal, and two
services must not hear it as one:

- **Simkl** moves a title from plan to watch to completed by itself when
  its history arrives. Its removal call is the un-watch call (rule 3), and
  the evidence gate would let it through — the title is on the Simkl plan
  list — so sent after the history push it would delete the watch just
  recorded. Nothing is sent.
- **MyAnimeList** deletes the whole list entry on a plan removal when the
  status is still plan_to_watch, which is where a progress push can leave
  it. The progress push's status change is the plan removal there. A
  grouped anime is an entry per season at MAL, so the push goes season by
  season, each entry with its own count and total (`planMalPushes` in
  `mal.ts`); a season the change did not touch is left alone.
- **Trakt**'s watchlist removal is scoped and harmless, so Trakt is told.

The local bookkeeping is cleared regardless: the sources record and the
origin, and any queued add for the title. A stale Simkl tag would be the
evidence a later un-plan needs to fire the destructive call; an origin left
standing would let the next pull remove the title again.

The pull side has the matching rule: a title with local watch history is
never planned by a pull, however many services still list it. Watched
outranks planned, and a service still listing something since seen is
stale data, not a new intent. The pull also records no removal evidence
for such a title while it is off the local plan, so the tag the mark
cleared cannot come back through the next sync.

The reverse move — clearing a title to **not watched** — touches history
only. Simkl and Trakt are told exactly the episodes that were held here,
never a bare show reference (which at Simkl removes the show's entire
history, including episodes watched elsewhere), and a plan the title
carried stays: the status reads planned again. Taking it off the plan is
"Remove from plan", the evidence-gated removal of rule 3, on purpose a
separate action.

## When Simkl's lists are read

Simkl counts requests per person, not per device (500 a day on a free
account), and a phone linked to the desktop uses the desktop's own Simkl
sign-in, so every device draws on one allowance. Simkl also asks every
client to read `/sync/activities`, one small request, before fetching any
list, and suspends clients that fetch lists without it.

So the half-hourly background sync (`src/main/media-hub/watchSync.ts`)
asks that one question first and reads only what moved:

- **The three plan-to-watch lists** are fetched when Simkl's activity
  stamp for films, shows or anime differs from the one they were last read
  under, and once a day even if none does. The daily read is there because
  some things on this side change what a read would do without touching
  Simkl: a queued removal given up on (rule 6), sync switched back on, a
  title that came from Simkl and has since left Trakt as well.
- **The watched library the desktop's review panel is compared against**
  is fetched when the films stamp moved, and only if the app's interface
  has asked for that panel since it started. The phone and TV app never
  do, so there it is never fetched.
- **Trakt and MyAnimeList** have no such question to ask, and are read
  every half hour as before.

On a day when nothing changes that is one Simkl request per half hour
instead of five. What is **owed** is not gated: plan changes a service
refused (rule 6) and watch-history decisions still queued are retried on
every pass, whatever Simkl said.

If the question itself fails, nothing behind it is fetched and Simkl is
reported with that error. A refusal Simkl sent (a spent allowance, a
server error) is waited out for longer each time it repeats, up to four
hours; a refused sign-in is asked again every six hours; a request that
never reached Simkl (this machine was offline) is simply asked again at
the next half hour.

"Sync now" is not gated. It reads every connected service, every time.

The record of what was read is kept per profile and per Simkl account, and
is shared with the phone and TV app's catch-up (below), so the two of them
read Simkl's lists once per change between them rather than once each.

## What this deliberately does not do

- **No merging of what a "list" means.** Trakt's watchlist, Simkl's
  plantowatch and MAL's plan_to_watch are treated as the same list. They
  are not quite: Trakt's watchlist holds seasons and episodes too. Only
  film and show entries participate.
- **No custom lists.** Named lists somebody built by hand are a separate
  feature, read-only first.
- **No history.** This is plan-to-watch only. Watch history has its own
  reconcile queue with its own review UI, and the two should not be
  confused for each other. The one exception is the phone and TV app's
  catch-up, below, which takes Simkl's history in without a review.

## The catch-up on the phone and TV app

The desktop settles disagreements with Simkl in a review panel. The phone
and TV app have no panel and nobody to ask, so they run a **catch-up**
(`src/main/media-hub/simklCatchUp.ts`; what it decides to write is in
`simklCatchUpRules.ts`, which is tested directly).

**Who asks.** Only the phone and TV interface, through `tracking.catchUp`:
when the app opens, when it comes back to the front, and straight after
linking to a desktop. The desktop app never runs it. A call within two
minutes of the last pass, or while one is running, is answered with that
pass's report; nothing runs while something is playing; a fresh link skips
the two-minute wait.

**What it reads.** First the watchlist pull above, so the plan is settled
before any history lands: the pull refuses to plan anything with local
history, so the other order would refuse a title for a viewing the same
pass wrote. Simkl's lists are skipped in that pull if they were already
read under the same activity stamps ("When Simkl's lists are read", above).
Then Simkl's watched history, one kind at a time (films, shows, anime), but
only for a kind whose activity stamp at `/sync/activities` has moved since
it was last fully applied. If that request fails, nothing is fetched and it
is tried again after a pause that lengthens up to an hour; a 401 or 403
stops the catch-up's own Simkl requests until the account is linked again
(the half-hourly background sync asks again every six hours, and the
history pushes are separate and keep trying). A kind whose fetch or write
fails waits out its own, longer, pause without holding up the others. A
library answer that was cut off part way counts as a failure, not as an
empty library. When Trakt or MAL is connected, the pull also runs at most
every ten minutes on its own. Anime waits until the catalog has been organised into its seasons, and
is asked for again a few minutes later.

**It only ever adds.** It writes viewings this device has no record of and
never removes one, however the Simkl library looks. A viewing already held
here is skipped rather than written again, because this device's own
viewing comes back from Simkl stamped differently and would otherwise
appear as a second play. Each title's state at Simkl is remembered, and a
title that has not changed since is left entirely alone. A film taken as
watched that is still on the plan comes off it, exactly as in rule 8:
Simkl and MAL are not asked to remove anything.

**How a show comes to be followed.** A show or anime that Simkl lists as
"watching", with a viewing in the last year, that is not already on the
local list, and of which the pass has just taken a viewing this device did
not have, is added to it. That last condition is what tells a viewing made
somewhere else from the echo of one made here: an episode played on this
device is pushed to Simkl and changes the title there too. This is local
only: nothing is pushed, because a plan add sent to Simkl would move a show
being watched back to plan to watch. "On hold" is not followed, and neither
is an anime film, special or music video. A title whose un-plan is still
owed to a service (rule 6) is not followed either. A show played on the
phone itself is followed the same way from its first episode, when it has
more than one playable episode.

**"Remove from My List" on a followed show** takes it off the local list
like any other un-plan. The catch-up does not follow it again until a
viewing of it made somewhere else arrives; playing it on the phone follows
it again at once. Rule 3 applies to the removal as it does anywhere:
with viewings recorded here, the unscoped Simkl removal is not sent.

**Known limits.**

- It is only as good as Simkl. A viewing Simkl never recorded cannot
  arrive. An entry with no IMDb id (films and series) or no resolvable
  Kitsu id (anime) is skipped and counted, not guessed. An episode Simkl
  holds without a usable date is left out. A finished film with no watched
  date is recorded at the date it was added to the list there, or failing
  that at the time of the catch-up.
- One direction. The desktop still does not take in episodes watched on the
  phone. Those reach Simkl through the ordinary history push; a film then
  shows up in the desktop's review panel, and an episode does not reach the
  desktop at all yet.
- Anime takes only each Simkl entry's own first-season numbering (its
  season 1, or none), filed under whichever season of the merged franchise
  that entry is here. An episode Simkl files under season 0, or 2 and
  later, is refused. Later seasons of a merged franchise that this app
  pushed may be misfiled under the first entry at Simkl; the catch-up skips
  an episode the device already holds under a later season, but cannot
  repair what Simkl holds.
- A local un-watch whose removal at Simkl failed can come back when that
  title next has activity there.

## How to undo it

Turn off "Keep watchlists in sync" in Settings → Accounts → Watchlists.
Pulling continues; nothing is pushed and nothing is removed locally. The
origins record is kept, so turning it back on resumes rather than
restarting.
