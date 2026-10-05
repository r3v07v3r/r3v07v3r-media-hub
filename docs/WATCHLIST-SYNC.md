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
- **The watched films the desktop's review panel is compared against**
  are fetched when the films stamp moved, or when the set of films watched
  here changed (a film marked here whose push to Simkl failed moves only
  this side), and only if the app's interface has asked for that panel
  since it started. The phone and TV app never do, so there they are never
  fetched. Films only: the panel compares nothing else, and the shows
  library with every episode's date, the largest thing the app asks Simkl
  for, is left to the MyAnimeList preview, which needs it. The desktop's
  own check a few seconds after launch asks `/sync/activities` the same
  way first, after the catch-up below has run (reusing the catch-up's
  answer when it is under a minute old), and when neither side's
  films moved since the last comparison it shows that one again rather
  than reading Simkl's films (a comparison is kept for a day).
- **Trakt and MyAnimeList** have no such question to ask, and are read
  every half hour as before.
- **The whole shows and anime lists**, for the desktop's episode comparison
  ("Episodes, show by show", below), are read when their own stamp moved
  since the last comparison, and at most every six hours however often it
  moves (half an hour after a comparison that left shows for the next).
  The comparison goes by the answer the catch-up or this pass just read,
  and asks no question of its own.

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

**Rate limits on writes.** Trakt allows an account one write a second, so
every Trakt request goes through a lane of its own in the request
scheduler (`taskScheduler.ts`), one at a time and a second apart. When
Trakt answers any write (history, a scrobble, a rating, a plan change)
with 429, or Simkl answers a mark, un-mark, season or whole-title push
with one, the request waits the time the service's `Retry-After` header
asks for (a second when it gives none) and is sent once more; a second
429, or a wait longer than a minute, is an ordinary failure
(`retryOnceOn429` in `httpClient.ts`).

**History pushes that fail are kept.** Marking an episode or a film,
un-marking one, marking a season and setting a whole title's status each
push the change to Simkl, Trakt and MyAnimeList after the local write. A
push that fails (offline, an expired token, a 5xx, a second 429) is
written down per service, title and episode (per season for MyAnimeList,
which is sent a recount) in a durable record per profile
(`historyRetry.ts`), stamped with the account it was owed to. It is sent
again at the start of every half-hourly pass and every "Sync now", one
request per service, title and direction, on the title's own push chain;
ten failed tries and it is let go, and the log says so. A try that never
reached the service (offline, a timeout) is not counted, though an entry
is still let go 30 days after it was written; and a service that does not
answer, or answers 429 or 5xx, is sent nothing more in that pass, so a
service that is down holds up "Sync now" for one request, not one per
title. A later push for the same episode replaces it, whichever way it
went, and one that got through clears it. An owed change local has since
moved away from (an add for an episode no longer watched here, a removal
for one watched again) is dropped rather than replayed. A retried add
carries no watched date, so the service records the viewing at the time of
the retry rather than when it happened. While a removal is owed to Simkl
or Trakt, or still on its way there, the catch-up and the Trakt history
pull do not take that viewing back in from that service. The Watchlists
panel (Settings → Accounts → Watchlists) shows how many changes are still
owed.

**Scrobbles are off unless turned on.** The player's start, pause and stop
messages to Simkl and Trakt are sent only when "Scrobble while playing" is
on (Settings → Accounts → Watchlists). Each is a request against Simkl's
daily allowance, and a finished episode or film is sent as a history add
at 80% whatever the setting says. The phone and TV player sends none
either way.

## What this deliberately does not do

- **No merging of what a "list" means.** Trakt's watchlist, Simkl's
  plantowatch and MAL's plan_to_watch are treated as the same list. They
  are not quite: Trakt's watchlist holds seasons and episodes too. Only
  film and show entries participate.
- **No custom lists.** Named lists somebody built by hand are a separate
  feature, read-only first.
- **No history.** This is plan-to-watch only. Watch history has its own
  reconcile queue with its own review UI, and the two should not be
  confused for each other. (In that review's films section: "Use Local"
  sends the local value to Simkl and then Trakt; "Use Simkl" rewrites the
  local record and sends Simkl's value on to Trakt. A Trakt failure is
  logged and does not undo either choice. Its shows section is "Episodes,
  show by show", below.) The exceptions are the catch-up, below, which
  takes Simkl's history in without a review, Trakt's history pull
  ("Trakt's history"), and the episode comparison; all three only add.

## The catch-up

Every device runs a **catch-up** (`src/main/media-hub/simklCatchUp.ts`;
what it decides to write is in `simklCatchUpRules.ts`, which is tested
directly): what Simkl says was watched elsewhere, and this library does
not have yet, is added without asking. It never removes anything, so it
needs no review. On the desktop, what it cannot settle by adding (Simkl
saying a film here is not watched, or a film it could not place) is still
the films section of the "Sync review" panel, whose check runs after it.
The phone and TV app have no panel, and the catch-up is all they have.

**Who asks.** Every interface, through `tracking.catchUp`. The phone and TV
app ask when the app opens, when it comes back to the front, and straight
after linking to a desktop. The desktop asks when its window opens and when
it comes back to the front, but for focus at most every ten minutes
(`useServiceCatchUp.ts`), because a desktop window gains focus far more
often than a phone resumes and each pass that gets through is a Simkl
request. A call within two minutes of the last pass, or while one is
running, is answered with that pass's report; nothing runs while something
is playing; a fresh link skips the two-minute wait. All of that is per
profile: a pass for one profile never answers for another, which gets its
own.

**What it reads.** First the watchlist pull above, so the plan is settled
before any history lands: the pull refuses to plan anything with local
history, so the other order would refuse a title for a viewing the same
pass wrote. Simkl's lists are skipped in that pull if they were already
read under the same activity stamps ("When Simkl's lists are read", above).
Trakt's and MyAnimeList's lists have no such gate, so on the phone they are
read at most every ten minutes; on the desktop they are left to the
half-hourly pass and read here only when Simkl's moved.
Then Simkl's watched history, one kind at a time (films, shows, anime), but
only for a kind whose activity stamp at `/sync/activities` has moved since
it was last fully applied. A kind is fetched whole the first time and with
`date_from` after that, which is what Simkl asks of a client that keeps in
step: only what changed since the stamp its last applied fetch was made
under. Once a week the fetch that is due anyway is whole again, in case an
incremental answer left something out. A kind Simkl gives no stamp for is
read once a day, not on every pass. If the activities request fails,
nothing is fetched and it is tried again after a pause that lengthens up to
an hour; a 401 or 403 stops the catch-up's own Simkl requests until this
device is linked again or six hours have passed, whichever comes first (the
half-hourly background sync asks again every six hours too, and the history
pushes are separate and keep trying). A kind whose fetch or write fails
waits out its own, longer, pause without holding up the others, and a kind
that was fetched but could not be placed in full (an id lookup nobody could
answer) is left ten minutes. Those pauses belong to the account and profile
that earned them. A library answer, or a plan-to-watch list, that was cut
off part way counts as a failure, never as an empty one. When Trakt or MAL
is connected, the pull also runs at most every ten minutes on its own, and
at once after a fresh link. Anime waits until the catalog has been
organised into its seasons, and is asked for again a few minutes later.

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
- Through Simkl. An episode or film watched on the phone reaches Simkl
  through the ordinary history push, and the desktop's next catch-up takes
  it from there; with Simkl not connected nothing travels between the two.
- Anime takes only each Simkl entry's own first-season numbering (its
  season 1, or none), filed under whichever season of the merged franchise
  that entry is here. An episode Simkl files under season 0, or 2 and
  later, is refused. The next section has the mapping, and what became of
  later seasons pushed before it existed.
- A local un-watch is not taken back in while its removal at Simkl is
  still on its way or owed after a failure (see "History pushes that fail
  are kept"). Once it has been given up on after ten tries, it can come
  back when that title next has activity there.
- A film the review panel's "Use Local" ruled not watched is not taken
  back in while that decision is still queued for Simkl, nor once the
  queue has given up on it (90 days). Taken in, the next flush would find
  both sides agreeing and pass "watched" on to Trakt, the opposite of what
  was chosen.

## Trakt's history

The "Import my Trakt library" button reads a whole Trakt account once:
every viewing with its date, and every rating. It is safe to press again.
Somebody who connects Trakt and never presses it still gets their past:
the pull below runs the same import once on its first pass (see "It
starts with the account's past").

After that, Trakt's history comes in by itself (`traktHistoryPull.ts`),
in the half-hourly background sync and in every catch-up (desktop launch
and focus; the phone and TV app hold no Trakt sign-in). Each pass asks
Trakt's `/sync/last_activities` first, one small request, and reads
`/sync/history` only when the films or episodes stamp there moved since
the last pull, and then only from the last pull on (`start_at`), reaching
back three days for a viewing that reached Trakt late. The record of where
the pull is, and under which stamps, is kept per profile and per Trakt
account, durably, like Simkl's stamps.

- **It only adds**, and files every viewing where the import does: a film
  or series under its IMDb id, an anime series under the merged show and
  season it belongs to here (the same `imdbToAnimeTargets` the import
  uses). While the anime catalog is still being organised it writes
  nothing and tries the same rows again next time.
- **A viewing already held here is skipped**, unlike the import. Every
  episode played here is pushed to Trakt and comes back on the next pull
  with Trakt's own time, and would otherwise be recorded as a second play.
  A rewatch on Trakt of something already watched here therefore adds no
  play here. A viewing un-marked here whose removal Trakt has not taken
  yet (on its way, or owed after a failure) is skipped the same way.
- **It starts with the account's past.** With nothing on record for the
  profile and account (no import has been run for it, and no pull), the
  first pass runs the import button's own code (`importTraktLibrary`,
  history and ratings, with its backup) once, leaving out every viewing
  already held here and every one whose removal Trakt has not taken, as
  above. Then it records Trakt's stamps and the time, and later passes read
  only what is new. If that import fails (the anime catalog still being
  organised, a profile switch) nothing is recorded and the next pass runs
  it again. An import pressed by hand records where the pull carries on
  from, so the pull never reads the whole account after one. An import
  made by a version that kept no such record is not known about, and the
  first pass reads the account again; with held viewings left out, that
  adds only what is missing.
  On the desktop, the first episode comparison against the account then
  takes in what Trakt holds of the shows held here ("Episodes, show by
  show").
- A viewing given to Trakt with a date older than three days before the
  last pull (a backdated entry) is not seen by the pull; the import finds
  it.
- A backup is written before it writes rows, at most once a day (see
  "When the grouping changes" for the backups).

## Episodes, show by show

Progress on a show is a set of watched episodes, here and at each service.
"Here S1E8, Trakt S2E2" is not two positions to choose between: it is the
episodes Trakt holds that this app does not (S1E9 to S2E2), and perhaps
some the other way round. So shows are compared as sets, show by show, and
nothing anywhere offers "keep S1E8 or S2E2".

The pulls above only add, so every episode a service has told this app
about is held here. What they cannot see is an episode held here that a
service does not have: a push that failed for good, a service connected
after the episode was marked. Nor could anybody see what a pull took in, to
take it back out. This is both (`src/main/media-hub/episodeSync.ts`, tested
in `tests/episodeSync.test.ts`).

**When it runs.** On the desktop only, after the catch-up (launch, focus,
and the launch check eight seconds after the window opens) and after the
half-hourly pass. The launch check does not wait for it: the films answer
first, and what the comparison adds reaches the panel and the top bar's
button when it is done, as does what any later pass adds. A service is read only when its activity stamp moved
since the last comparison under that account: Simkl's shows and anime
stamps as the catch-up or the pass just read them (the comparison asks
`/sync/activities` nothing of its own, and leaves Simkl alone when that
answer is more than five minutes old), and Trakt's episodes stamp as the
history pull recorded it. When one moved, that service's whole set is read
once: Simkl's `shows/all` and `anime/all` lists, each behind its own stamp
and at most every six hours (see "When Simkl's lists are read"), or Trakt's
`/sync/watched/shows`, one request. A pass where nothing moved costs
nothing beyond what the pulls already asked.

**It takes the union, and only adds (rules 1 and 4).**

- Episodes held here that the service lacks are sent to it as an add, on
  the title's own push chain, so a failure is kept and retried like any
  history push. Not an episode marked here in the last fifteen minutes (its
  own push may still be on the way, and a second add is a second play at
  Trakt), one with a change owed to that service, or one that arrived from
  that service and has since gone from it: it was removed there, and
  sending it back would undo that. Nor one already sent to that service
  under the same account: still missing, it was either not taken (the
  service files it under another id or number) or removed there since,
  and sending it at every comparison would add a play at Trakt each time.
  Each episode is sent with the time it was watched here, so a backlog
  does not land in the service's history as watched today (a retry after
  a failure goes without it, as any retried push does, and an anime at
  Simkl is sent undated, since its numbers there are the entry's).
- At most twenty shows per service per comparison. A comparison that left
  shows over is recorded as partial: the service is read again on the next
  moved stamp, but not within half an hour (not six hours, for Simkl), and
  since the shows just sent are not sent again, the rest move up.
- Episodes only the service holds are already here: the catch-up reads
  each of Simkl's kinds whole the first time. The Trakt pull starts from
  the moment it first runs, so the first comparison against a Trakt account
  takes in what Trakt holds of the shows held here. Shows not held here at
  all are the import button's. After the first, what arrives at Trakt comes
  in through the pull.
- Nothing is removed, here or at any service. A local removal still wins
  (rule 4): an episode whose removal is owed or on its way is neither taken
  back in nor counted against the service.

**Rule 5 holds.** A read that failed, came back cut off, or (for anime)
held an entry nobody could be asked to look up writes nothing and records
nothing, and its stamp is left, so the next pass reads it again.

**What is compared where.**

- Series, at Simkl and Trakt, by IMDb id. A show a service holds with no
  IMDb id cannot be matched: its episodes here are sent to it once, and
  not again.
- Anime at Simkl, entry by entry, placed by the rules every Simkl push uses
  ("Anime: one show here, an entry per season at Simkl", below): a later
  season only where `laterSeasonOf` can show its place is its season on the
  page. A member that cannot be shown to be its season keeps its whole show
  out of the comparison, since compared by position it would send the
  wrong season or report one missing. A season the rules name no entry for
  (`toSimklAnimeEpisode` gives none) is listed as **cannot be sent to
  Simkl**, not sent. Specials are not compared.
- Anime is not compared at Trakt. This app never sends anime there, and
  Trakt keeps an anime under an IMDb series this app keeps under a Kitsu
  id. An anime's row says **cannot be sent to Trakt** for its seasons.
- MyAnimeList keeps a count per entry, not episodes, and is not read. When
  a choice below removes anime episodes here, the seasons it touched are
  recounted and sent (`planMalPushes`), as any change here is.

**The record of what was merged.** Per show and per service: the episodes
that arrived (from the catch-up, the Trakt pull or the comparison), the
ones sent, and the ones that cannot be sent. One durable entry per profile
(`episode-sync:merged:v1`), each service's part stamped with its account
(rule 7) and inert under any other. A show leaves it when it is reviewed,
or 90 days after a pass last added to it. The same unsendable episodes
found again do not bring a reviewed row back; a different set does.
Besides the rows, it keeps per show, service and account what arrived and
what was sent, for a year after the last addition. A review does not clear
this; it is what the comparison goes by when it leaves out what came from
a service, or was already sent to it. The
phone and TV app keep the add-only catch-up and have no panel, and their
pulls write the record all the same. What the phone takes in reaches the
desktop through the services, and the desktop's own pulls record it there.

**The shows section of the review panel.** The desktop's **Sync review**
panel lists each show in the record: how many episodes arrived from which
service, how many were sent where, how many cannot be sent, and, opened,
which, season by season. Merging both is what has already happened, so the
choices are the ways back from it:

- **Keep** (the x): the merge stands, and the row goes.
- **Undo**: the episodes that arrived are removed here, at the service
  they came from, and at any service the comparison passed them on to.
- **Make _service_ match here**: the service ends up with what was held
  here before the merge. What arrived from it is removed here and there
  (and wherever it was passed on), and what it lacked is sent again.
- **Make here match _service_**: this app ends up with that service's set.
  What was held here and not there is removed here, taken back from the
  service where the comparison had sent it, and removed at the other
  service as well, except what this app saw arrive from that other
  service. That one was recorded there by itself, not put there from here,
  and like a planned title (rules 2 and 3) a removal only goes where this
  app put the thing. What arrived from the service is sent on to the other
  service (rule 1).

These are the only way an episode is ever removed at a service, and each
is somebody's decision about one show. Every removal names its episodes; a
show reference never goes out without them (rule 3: at Simkl a bare one
removes the show's whole history). What a choice cannot send, a season
with no entry or anime to Trakt, is said, and left as it is there. Where
that is an Undo of episodes that came from that service (Trakt's
viewings the pull filed under an anime here), the service's pulls leave
those episodes out for 30 days, long enough for the Trakt pull's three
days of overlap to pass, so the Undo is not taken back in.

**A choice stands once made.** It is written down before anything changes:
the changes for the services go into the same durable record as a failed
history push ("History pushes that fail are kept"), stamped with the
account; then the row leaves; then the episodes are removed here, after a
backup at most once a day. A choice that cannot be written down changes
nothing and says so. The changes go out three seconds after the last
choice with the other owed pushes, one request per service, title and
direction, and again with every half-hourly pass and **Sync now** until
they land, on that record's terms: ten tries, offline tries free, let go
after 30 days. (The films section's "Use Local" queue gives up after five
tries and keeps a decision 90 days; the shows' changes are history pushes
and are kept like the others.) A push that fails does not bring the row
back, or the episodes back here. While a removal is owed, the catch-up,
the Trakt pull and the comparison do not take that episode back in from
that service.

**Known limits.**

- Rows start from this change: what earlier pulls took in was never
  recorded, so it cannot be undone from the panel.
- An episode a second service already held before the merge stays there
  after Undo: nothing recorded it as that service's. The comparison does
  not take it back in, but the Simkl catch-up does the next time that show
  changes at Simkl (rule 1), and it arrives as a new row.
- A Trakt-only show is not taken in by the comparison; the import button
  brings an account's past in.
- "Make here match" cannot tell a viewing the other service recorded
  before rows were kept from one this app put there, and removes it there.

## Anime: one show here, an entry per season at Simkl

This app merges a franchise's seasons into one show. Watch history is kept
under the first season's Kitsu id, and "season 2" means the second member
of that group. Simkl, like MyAnimeList, keeps an entry per season, each
numbered from episode 1, and an anime id names one of those entries.

So every anime episode sent to Simkl (a mark, an unmark, a whole season, a
whole title, a scrobble) is translated first, by `toSimklAnimeEpisode` in
`src/shared/media-hub/serviceIds.ts`:

- Season _s_, episode _e_ of a merged show goes out as episode _e_ of the
  group's _s_-th member, under that member's own Kitsu id and with no
  season number. A change that spans seasons is one entry per season, the
  same split `planMalPushes` makes for MAL.
- Only where that member can be shown to BE season _s_ of the page (see
  "When a member's place is not its season", below). Otherwise the season
  is not sent.
- A title that was never merged is its own entry.
- Specials (season 0) are not sent. They are TMDB's list for the whole
  franchise and belong to no entry this app can name.
- A season the group has no member for is not sent.
- While the anime catalog is still being organised into its seasons, only
  a first season is sent. A later one is skipped rather than queued, and
  reaches Simkl when it is next marked.
- A later season's entry is named by its id alone. The title and year in
  hand are the show's, and Simkl matches on those when it cannot place an
  id, which would land on the first season.
- No entry goes out without its episodes. At `/sync/history/remove`, an
  anime reference that names none removes that entry's whole history.

The catch-up reads the same mapping backwards (`fromSimklAnimeEpisode`):
episode _e_ of an entry is kept under the show that entry's Kitsu id
belongs to, at the season it is there. `tests/simklAnime.test.ts` runs the
two round trip, and through the catch-up's own rules.

**Not verified against Simkl.** The request shape is the one Simkl's anime
guide gives for an anime id: an `anime` entry with a flat `episodes` list.
The tests model an account that behaves as that guide says. No request has
been made to the live API from a development machine, so whether Simkl
files these as described is still to be confirmed on a real account.

### When a member's place is not its season

"Season = the member's place in the group" is true of history, and not
always of the page. A merged show's page is numbered in one of two ways
(`buildGroupedAnimeVideos` in `animeSeasons.ts`):

- A show whose first member has no TheTVDB mapping is built from its
  members in order. Season _N_ is member _N_.
- A show whose first member has one is numbered by TMDB. Season _N_ is
  TMDB's season _N_, whichever member sits at _N_. The two agree only for a
  member whose own TheTVDB season is its place. A film or an OVA among the
  seasons, or a later season Kitsu has no mapping for, breaks it: My Hero
  Academia's fourth season is the group's seventh member, and season 7 on
  its page is TMDB's seventh.

So everything in this section that turns a member into a season of the
show, or a season into a member, asks first whether the two can be shown to
agree (`animeSeasonMatchesPage` in `serviceIds.ts`, read from the cached
mappings with no request). Where they cannot:

- that season is not sent to Simkl, rather than sent to whatever member
  holds that place;
- a later season opened by its own id opens and saves as itself, as it did
  before, and its rows are not moved under the show.

In one real library, 290 of 698 later seasons could be shown to agree. The
catch-up, the MAL import and the MAL push still go by place alone; that is
unchanged here and is wrong for the same shows.

### Films, OVAs and specials are not seasons

Kitsu says what kind of entry each anime is: a TV series, a film, an OVA,
an ONA (a web release), a special or a music video. The grouping reads it
(`normalizeKitsuAnime` keeps it as `subtype`), and only TV entries become
seasons of a merged show. Before, every entry the evidence linked was
merged in as a numbered season: a film took a season's place, pushed the
seasons after it one place along, and, since TheTVDB files films at season
0, could sort first and front the show, leaving no later season provably
at its place.

- A film, OVA, ONA, special or music entry stays a title of its own, with
  its own page, its own rows and its own Simkl and MyAnimeList entry. It is
  still listed in the franchise guide, and the show's page lists it between
  the seasons it came out between, by Kitsu's start dates (`groupedExtras`
  and `seasonStarts` on the show's catalog entry).
- It still links the seasons on either side of it. A first season whose
  only recorded sequel is a film, and the film's own sequel the second
  season, are one show of two seasons.
- An entry whose kind is not known is grouped as before. A catalog cached
  before this change has no kinds, so the change takes effect with the
  next crawl, within six hours of the update.
- A show whose real seasons Kitsu lists as ONAs comes apart: each such
  season is a title of its own. Kitsu's kind is the only signal there is,
  and telling which web releases are seasons would be a guess.

The change reaches watch history the way any change of grouping does
("When the grouping changes", below). On a show numbered by its members,
the rows kept for a film at its season go back under the film's own id, and
the seasons after it close the gap. On a show numbered by TMDB, the rows
were TMDB's seasons and stay at their numbers; where the film fronted the
show, they move to the id that fronts the series now. Where the film
fronted a show of one season, there is no show left: that season's rows go
to the season's own entry.

### A later season under its own id

A later season of a merged show still has an id of its own. One thing
keeps using it, and nothing else does. All of this applies to a later
season whose place is its season on the page (above); any other still
behaves as a title of its own.

- **The plan uses it.** A service lists a season under that season's id,
  so a watchlist pull plans it under that id, as its own card. That is on
  purpose: the id names the entry at the service, so taking the card off
  the plan can only ever remove that entry. MAL deletes the entry it is
  asked about when its status is still plan to watch; planned under the
  show's id, the same removal would be aimed at the first season's entry.
- **Nothing else does.** Opening such a card opens the show's page at that
  season, on the desktop and on the phone: a merged season has no page of
  its own. Play on the card plays the show from that season. An episode
  marked, a bookmark saved or a scrobble sent under a later season's id is
  kept under the show, at the season that id is there. The card's watched
  and not watched act on that one season of the show.
- **The card reads that season too.** Its watched and completed badge and
  its progress are counted from the show's viewings at that season, since
  none are kept under its own id: `tracking:list` answers with where each
  started later season's viewings are (`laterSeasons`), and the index counts
  a later season's completion there as well. On the desktop this covers
  every grid such a card appears in — the plan, My Stuff and the lists. The
  side panel names the episode Play will start, from the same viewings.

The Anime library and anime search do not list a later season at all. The
index keeps a row for every season, so the grid used to show each one as a
tile of its own; the library's query now leaves out every id that is a
later season of a merged show, in the same statement that counts the
total, on the desktop and on the phone. Search leaves those rows out of its
index half, and a hit for a later season (from the index or from Kitsu) is
answered with its show, in the place the season would have taken, so a
season's own name still finds something. Only the seasons whose place is
their season on the show's page are left out: any other member still opens
as itself, and its tile is how it is reached. A plan card under a later
season's id is read by id and still shows. With the later seasons gone,
Hide watched and Hide completed read every tile that is left by its own id,
which is where its viewings are kept.

Recommendations go by membership, not by place. The suggestion row and the
For You shelves draw on the index as well as the catalog, and the index
keeps a row for every member of a merged show, so a later season used to be
offered as a title of its own, including one already watched to the end
(its viewings are under the show, not under the id that was checked). No
member is offered now, and the show's own row is the one that competes for
a place. A member is dropped as a candidate, dropped again when a stored
list is read, and is not offered as what comes next either: the next season
of a merged show is inside the show. This is every member, not only the
ones whose place is their season, since nothing here acts on the place: a
film or an OVA the grouping filed among the seasons is not suggested on its
own either.

Home follows the same split. A later season on the plan with nothing of it
watched is in Plan to Watch as its own card. Once an episode of it has been
watched, the show takes its place in Continue Watching.

Before this, a later season opened by its own id was a separate one-season
title. What was watched there was saved under that id, where the show's
page never read it and the count sent to MyAnimeList (read from the show's
rows) left it out. Rows already saved that way are moved under the show
once, in the background, after the anime catalog has been organised
(`animeSyncRepair.ts`). Nothing is sent to a service when they move;
MyAnimeList hears the right count the next time that season changes here.

Until the catalog has been organised into its seasons nothing can tell a
later season from a title that stands alone, so in that window a later
season still opens, and saves, as itself.

### When the grouping changes

The grouping is worked out again every time the anime catalog is
refreshed, and it does not always come out the same. Which season fronts a
show, and the order of the rest, depend on lookups (a TheTVDB mapping,
AniList's broadcast dates) that answer on one run and not on the next, and
a season can enter or leave the crawl. In one real library, five weeks
changed the members or order of 62 of 286 shows and put a different id in
front of 43.

History is addressed by both of those things: the id in front, and the
season's place in the order. So the app keeps a record of the grouping the
rows are filed under (the ledger, one row in the database), and when a
refresh lands a different one, the rows are moved in the same moment
(`animeRegroup.ts`). History, plays, resume points and the rating move,
for every profile, in one transaction. Nothing is sent to a service.

What moves depends on how the show's page numbers its seasons:

- **A show with no TheTVDB mapping** is numbered by its members: season 3
  is the third member's episodes. Its rows follow their member. A new
  front, a new order, a member leaving (its season goes back under its own
  id) and a member joining are all followed.
- **A show with a TheTVDB mapping** has its page filled from TMDB: season 3
  is TMDB's season 3, whichever member sits third. A member changing place
  does not change what season 3 shows, so its rows stay at their numbers.
  Only a new id in front is followed, with the season numbers kept, and
  only when both ids map to the same series. That includes a front that is
  in no show any more (a film that used to sort first), when the rest of
  its show is all fronted by one id of the same series. A front that was in
  a show numbered by its members goes the same way for its specials and
  its rating.
- **A show with a TheTVDB mapping that comes apart**, every member standing
  alone (one TV season left once a film or an OVA stops being one, or a
  second season Kitsu calls an ONA): each TMDB season under the old front
  goes to the one former member whose own TheTVDB season it is, as that
  entry's own episodes, and the rating goes with season 1. Season 0, and a
  season no member can be shown to be, stay where they are and the log
  names the show.
- **A later season whose place becomes its season** on a show numbered by
  TMDB (a film before it left, so its place moved down to its TheTVDB
  season) opened and saved as itself until then, so its rows are under its
  own id. From now on it opens as the show and the library does not list
  it, so those rows and its rating move to the show at its season.
- **Anything else is left where it is**, and named in the log: a show that
  gained or lost its mapping between two runs, or one whose lookup has
  never answered. A wrong move puts rows on another season's, where the
  ones already there win and the arrivals are dropped.
- **A title that stood alone and joins a show as a later season** is moved
  under the show only where its place is its season on the page ("When a
  member's place is not its season", above). On a show numbered by TMDB
  that is often not so, a film or an OVA taking a place among the seasons;
  such a title still opens and saves as itself, and keeps its rows.

The plan is not moved. A planned title keeps its own id whatever the
grouping does, for the reason given above.

A row already at the place a move lands on is kept, and the arriving copy
of that episode is dropped. Plays are all kept, except a viewing already
there at the same instant.

A backup carries the ledger, and a restore puts it back with the rows, so
rows restored after the grouping has moved on are brought to where it is
now. A backup from before the ledger has none; its rows are taken to be
filed the way the install's own are.

Before the regroup or the repair moves any rows, the app writes a backup of
the whole library into a `backups` folder in its data folder
(`autoBackup.ts`). So do the Trakt import (and its half-hourly pull, at most
once a day) and the MyAnimeList apply before they write. These are ordinary
backups that **Restore** reads. The newest five are kept, and each one
written is a line in the log. A backup that cannot be written is logged and
does not stop the step.

**Rows from before the ledger.** The first run only records the grouping;
it has nothing to compare it with. An id that fronted its show before then
and is a later season now still holds the whole show's rows, in an order
nothing recorded. The repair places them once, where the old order can be
shown rather than guessed:

- Its own season is always placed (it was the first).
- The catalog index still remembers the siblings an id had when it fronted
  a show. Where no season under the id contradicts that order, each season
  watched in full goes to the member the order names, if that member has
  exactly that many episodes.
- Without a usable remembered order, lengths alone decide, and only for
  all the seasons together: every one watched in full, each matching
  exactly one member's episode count, no member twice. Five episodes
  marked could be a five-episode season or the start of a longer one, so
  one season that cannot be placed leaves the rest as well.
- Only on a show numbered by its members.

What cannot be placed stays under the old id, and the log names it.

**Not covered.** On a show numbered by TMDB, the page and the services
disagree about a season number wherever the members are not exactly the TV
seasons in order (a TV entry with no TheTVDB mapping, or one TMDB season
that Kitsu splits in two; a film or an OVA is no longer a member): the page
shows TMDB's season, while Simkl and MyAnimeList are sent the member at
that position. This change does not
alter that, and it is why such a show's rows are not moved by member.

### Pushes made before the mapping

Until this change a later season went out under the first season's id with
a season number. Simkl most likely filed it as that episode number of the
first season, or dropped it.

- **Nothing is re-sent and nothing is removed.** Later-season episodes
  marked before the change are still missing from their own entries at
  Simkl, and any that were misfiled are still on the first season's. The
  app cannot tell a misfiled episode from a first-season one watched
  somewhere else, so it leaves both alone.
- Marking such an episode again (or its season, or the title) sends it to
  the right entry. The misfiled copy stays until it is removed at Simkl by
  hand; un-watching the episode here asks only its own entry.
- The catch-up keeps its guard: a first-season episode at Simkl is skipped
  when this device holds the same episode number under a later season and
  not under the first. That is what stops this device's own old pushes
  coming back as season 1.
- A device that never held the later-season row (a phone linked
  afterwards, or one where the episode was since un-watched) has nothing
  to recognise a misfiled episode by, and takes it as a first-season
  viewing.
- The guard has a cost that outlives the fix: a first-season episode
  really watched somewhere else is skipped for as long as this device
  holds that episode number under a later season only.

## How to undo it

Turn off "Keep watchlists in sync" in Settings → Accounts → Watchlists.
Pulling continues; nothing is pushed and nothing is removed locally. The
origins record is kept, so turning it back on resumes rather than
restarting.
