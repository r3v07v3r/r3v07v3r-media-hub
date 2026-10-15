# Two-way watchlist sync

The rules this app follows when your plan to watch and your watch history
are kept at Simkl, Trakt and MyAnimeList as well as here. Rules 1 to 8
cover the plan, where a pull can **delete** something somebody meant to
keep, so its policy is stated rather than discovered; the sections after
them cover watch history.

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

### 1. Adds propagate both ways, to every service that takes the title

Marking Plan to Watch here pushes to every connected service that takes
that kind of title: Simkl and Trakt are sent films and series with an IMDb
id, MyAnimeList is sent anime. An anime planned or un-planned here is not
sent to Simkl, though Simkl's anime plan list is read. A service that does
not take a title is skipped, not owed, so nothing is queued for it. A title
appearing on any service's list is added here. Adds are safe: the worst
case is a title on a list you did not put it on, which is one click to undo
and loses nothing.

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

One more condition holds a removal back even with an origin: **a title that
has been started here is never removed by a pull.** Leaving plan to watch
at a service is what starting a show looks like there. Simkl moves it to
"watching" on the first episode, and MAL when a progress push sets its
status, so a series that was planned at a service and then watched is
absent from that service's plan list without anybody having removed it.
Read as a removal, it would untrack the show and drop it out of Continue
Watching. (A push from here moves a MAL entry to watching or completed only
when it carries the entry's episode total; see "Anime: one show here, an
entry per season at Simkl".) "Started" means a viewing recorded under the
title, or under the show a merged anime season belongs to. Films are not in
this set. A film marked watched from its card, page or menu leaves the plan
by rule 8. One finished in the player, here or on the phone, stays planned
on that device: one a pull brought in is removed by a pull once no service
lists it (Simkl moves a watched film to completed), and one planned there,
with no origin, stays on the plan.

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
the other way destroys history nobody can get back. Anime is never sent to
Simkl in either direction (rule 1), whatever the pull found.

Evidence is necessary but not always enough: **the unscoped removal is
never sent for a show with viewings recorded here.** Simkl's request there
is a bare show reference, which erases the show's whole history, including
episodes watched elsewhere. Taking a half-watched show off the list here
means "stop showing me this", not "forget I watched it"; rule 8 says the
same about a title marked watched. The same holds when a queued removal is
retried after the show was started: a removal owed only to Simkl then sends
nothing and is dropped as settled. Trakt and MAL are unaffected.

### 4. Nothing settles a conflict at sync time

An un-plan here is sent at once, not held for the next sync, and while it
is owed the queue in rule 6 keeps the pull from adding the title back.
Nothing else compares the two sides, so a removal here does not hold:

- against a re-add at a service after the removal landed: that is a new
  add there, and the next pull plans it here again (rule 1);
- at Simkl, when the last pull found no Simkl evidence: the un-plan sends
  nothing (rule 3) and queues nothing, so a re-add there in the meantime
  comes back;
- for an anime planned from Simkl's list: an anime un-plan is never sent to
  Simkl (rule 1), so the next read of that list plans it again;
- with **Keep watchlists in sync** off: nothing is sent or queued ("How to
  undo it").

In each case the title comes back only if it has no viewing here: a title
watched here is never planned by a pull (rule 8).

### 5. A failed pull deletes nothing, with two exceptions

If a service errors, its titles are not treated as absent. Absence has to
be a **successful** answer that did not contain the title, not the absence
of an answer. A network outage must never read as "the user emptied their
watchlist" — this is the same refusal that keeps the source tags when every
service fails. An answer from Simkl that was cut off part way (the request
timed out, or the connection dropped while it was being read), or that
cannot be read, is a failure too, never an empty list.

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

**Where this does not hold.** Two kinds of answer still read as a shorter
list:

- A Trakt watchlist or MyAnimeList plan-to-watch list that arrives cut off
  part way, or does not parse, reads as an empty or shorter list. The
  titles planned from that service that are missing from it are removed
  here (rule 2's other conditions still apply) until the next pull brings
  them back. A MyAnimeList list cut off after its first page drops only the
  titles on the pages it lost.
- An anime on Simkl's or MyAnimeList's list whose Kitsu id cannot be looked
  up on this pass (no cached mapping, and the lookup unreachable) is left
  out of that service's answer as if it were not listed, and a title
  planned from that entry can be removed the same way.

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

The same queue holds an **add** a service refused, so that rule 1 holds
through an outage. A queued add is retried on the same schedule, and once
it lands it counts as evidence of presence (rule 3) exactly as an add that
succeeded first time would. A queued add never suppresses anything: the
title is on the local list already, and a pull that finds it at a service
that did take it is free to record that.

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

The mark comes from the sign-in, not the person: it is a hash of the access
token. Connecting again counts as a different account whenever the service
hands out a new token, even for the same account. At Trakt and MyAnimeList
so does each automatic token refresh (Trakt's in the week before its token
expires, MyAnimeList's in the last five minutes). Simkl's tokens are not
refreshed, so there only a reconnect does it. Linking the phone again with
the desktop's unchanged Simkl token keeps the same mark. Under a new mark,
everything stamped under the old one is inert:

- A title planned from that service can no longer be removed by a removal
  there.
- Plan changes and history pushes still owed to it are let go, with no line
  in the log.
- Simkl's plan lists and history are read in full once more, because the
  stamps they were last read under belong to the old mark.
- The Trakt history pull runs the whole-account import again, adding only
  what is missing and taking its backup. A viewing un-marked here whose
  removal Trakt had not taken yet was let go with the rest, so that import
  brings it back, and so does an undo of anime episodes the panel could not
  remove at Trakt.
- The episode comparison treats the service as newly connected: what it
  sent there and what arrived from there under the old mark are forgotten,
  so it can send back an episode removed at the service since it arrived,
  and send once more one the service never took. At Trakt it also takes in
  what Trakt holds of the shows held here. Sync review rows made under the
  old mark are no longer shown.

### 8. Marking a planned title watched takes it off the plan — without a removal

The app has one status per title: not watched, plan to watch, watched.
Setting a planned title to watched from its card, page or menu (a film, or
every aired episode of a show) drops it from the local plan. The player's
80% mark records the viewing and leaves the plan as it is. Dropping it is
NOT rule 3's removal, and two services must not hear it as one:

- **Simkl** moves a title from plan to watch to completed by itself when
  its history arrives. Its removal call is the un-watch call (rule 3), and
  the evidence gate would let it through — the title is on the Simkl plan
  list — so sent after the history push it would delete the watch just
  recorded. Nothing is sent.
- **MyAnimeList** deletes the whole list entry on a plan removal when the
  status is still plan_to_watch, which is where a progress push can leave
  it. When the push carries the entry's total, its status change is the
  plan removal there. A grouped anime is an entry per season at MAL, so the
  push goes season by season, each entry with its own count
  (`planMalPushes` in `mal.ts`), and with its total only when the whole
  title is marked watched (see "Anime: one show here, an entry per season at
  Simkl"); a season the change did not touch is left alone. A merged show
  finished one episode or one season at a time is sent no total, so an
  entry on plan_to_watch there stays on it with the new count, and nothing
  here removes it.
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
- **The watched films the desktop's review panel is compared against** are
  fetched when the films stamp moved, or when the set of films watched here
  changed (a film marked here whose push to Simkl failed moves only this
  side), and only if the app's interface has asked for that panel since it
  started. The phone and TV app never do, so there they are never fetched.
  Films only: this check compares nothing else (the shows in Sync review
  come from the episode comparison), and the shows library with every
  episode's date, the largest thing the app asks Simkl for, is left to the
  readers that need it: the MyAnimeList preview and the episode comparison
  (below). The desktop's own check a few seconds after launch asks
  `/sync/activities` the same way first, after the catch-up below has run
  (reusing the catch-up's answer when it is under a minute old), and when
  neither side's films moved since the last comparison it shows that one
  again rather than reading Simkl's films (a comparison is kept for a day).
- **Trakt's and MyAnimeList's lists** are read every half hour. MyAnimeList
  has no such question to ask. Trakt has one, `/sync/last_activities`, and
  its history pull asks it first ("Trakt's history"), but the watchlist
  reads do not.
- **The whole shows and anime lists**, for the desktop's episode comparison
  ("Episodes, show by show", below), are read when their own stamp moved
  since the last comparison, and at most every six hours however often it
  moves (half an hour after a comparison that left shows for the next).
  The comparison goes by the answer the catch-up or this pass just read,
  and asks no question of its own.

The pass first runs about four minutes after the app starts, on the desktop
and in the phone and TV app's backend alike, then every half hour. It waits
while something is playing, and runs as soon as playback stops.

**What it costs at Simkl.**

- A half-hourly pass where nothing changed: one request, plus the three
  plan lists once a day.
- Shows or anime moved: four (the question and the three lists). Films
  moved: four on the phone and TV, five on the desktop, which also reads
  the watched films for the review panel.
- A catch-up where nothing changed: one. After something was watched
  elsewhere: about five.
- A device's first catch-up: seven (six while anime waits for the catalog
  to be organised), plus one Simkl id lookup (`/search/id`, Client ID only)
  for each anime on the plan list, and each anime in the library with no
  Kitsu id of its own, not looked up in the last 30 days.
- On the desktop, the episode comparison's whole-list reads (above), and
  one request for each show it sends.
- A Trakt import, and each Trakt pull that reads viewings: one id lookup
  (`/search/id`, Client ID only) for each show among them not looked up in
  the last 30 days, so a first import of a long history makes one per show
  ("Trakt's history").
- Every mark, un-mark and scrobble: one more.

Requests to Trakt and MyAnimeList themselves are not counted here.

What is **owed** is not gated: plan changes a service refused (rule 6) and
watch-history decisions still queued are retried on every pass, whatever
Simkl said.

If the question itself fails, nothing behind it is fetched and Simkl is
reported with that error. A refusal Simkl sent (a spent allowance, a
server error) is waited out for longer each time it repeats, up to four
hours; a refused sign-in is asked again every six hours; a request that
never reached Simkl (this machine was offline) is simply asked again at
the next half hour.

**Sync now** is not gated: it reads every connected service, or takes the
answer of a catch-up already reading all of them, Simkl included. Only one
watchlist pull runs at a time, so the half-hourly pass, **Sync now** and
the catch-up never write over each other's changes. **Sync now** pressed
while the half-hourly pull is running waits for that pull to finish and
then reads every service again, because the running pull may have asked
before something was added on the web. The button stays on Syncing… through
both. The catch-up waits the same way.

The record of what was read is kept per profile and per Simkl account, and
is shared with the catch-up on the same device (below), so the two of them
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
push that fails (offline, an expired token, a 5xx, a second 429) is written
down per service, title and episode (per season for MyAnimeList, which is
sent a recount) in a durable record per profile (`historyRetry.ts`),
stamped with the account it was owed to.

It is sent again at the start of every half-hourly pass and every
**Sync now**, one request per service, title and direction, on the title's
own push chain. Every try the service answers counts, a 429 or a 5xx
included; after ten the change is let go (the log says
`history:push-abandoned`). A try that never reached the service (offline, a
timeout) is not counted, but the first such try after an entry is 30 days
old lets it go.

A try answered with a 429 or a 5xx, or that never reached the service,
stops that service for the rest of the pass, so a service that is down
holds up **Sync now** for one request, not one per title, and the other
titles owed to it wait their turn. With only the half-hourly pass running,
the first change owed to a service answering 5xx or 429 is let go after
about four and a half hours; the ones behind it take proportionally longer.

A later push for the same episode replaces it, whichever way it went, and
one that got through clears it. An owed change local has since moved away
from (an add for an episode no longer watched here, a removal for one
watched again) is dropped rather than replayed. A retried add carries no
watched date, so the service records the viewing at the time of the retry
rather than when it happened. While a removal is owed to Simkl or Trakt, or
still on its way there, the catch-up and the Trakt history pull do not take
that viewing back in from that service. The Watchlists panel (Control
centre → Accounts → Tracking) shows how many changes are still owed.

**Scrobbles are off unless turned on.** The player's start, pause and stop
messages to Simkl and Trakt are sent only when "Scrobble while playing" is
on (Control centre → Accounts → Tracking). Each is a request against
Simkl's daily allowance, and a finished episode or film is sent as a
history add at 80% whatever the setting says. The phone and TV player sends
none either way.

## What this deliberately does not do

- **No merging of what a "list" means.** Trakt's watchlist, Simkl's
  plantowatch and MAL's plan_to_watch are treated as the same list. They
  are not quite: Trakt's watchlist holds seasons and episodes too. Only
  film and show entries participate.
- **No custom lists.** Named lists somebody built by hand are a separate
  feature, read-only first.
- **No history rules of their own.** Rules 1 to 6 cover the plan to watch
  only; rule 7's stamps and rule 8's mark and un-mark reach watch history
  as well. Watch history is otherwise pushed as it changes here, taken in
  by the catch-up, Trakt's history (its pull and the Import button), the
  episode comparison and the MyAnimeList apply, all of which only add, and
  undone from Sync review.

## The catch-up

Every device runs a **catch-up** (`src/main/media-hub/simklCatchUp.ts`;
what it decides to write is in `simklCatchUpRules.ts`, which is tested
directly): what Simkl says was watched elsewhere, and this library does
not have yet, is added without asking. It never removes a viewing, so it
needs no review. On the desktop, what it cannot settle by adding (Simkl
saying a film here is not watched, or a film it could not place) is still
the films section of **Sync review**, whose check runs after it. The phone
and TV app have no panel, and the catch-up is all they have.

**The films section of Sync review.** "Use Local" sends the local value to
Simkl and then Trakt, and "Use Simkl" rewrites the local record and sends
Simkl's value on to Trakt. A "Use Local" that Simkl does not take is
retried there first, and reaches Trakt only once Simkl has it. A "Use
Local" still owed to Simkl is given up after five tries, and the decision
is kept 90 days. A Trakt failure is kept and sent again like any failed
history push, and undoes neither choice. The x (Ignore) stops asking about
the film; the list of ignored films is kept 90 days after the last one was
added, and then they can be listed again. A film saved under an id only
this app knows cannot be sent: it shows **Can't push** in place of "Use
Local", and "Use Simkl" is the way to settle it.

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
Trakt's and MyAnimeList's lists have no such gate. The phone and TV app
hold no sign-in for either; on the desktop they are left to the
half-hourly pass and read here only when Simkl's moved. Then Simkl's
watched history, one kind at a time (films, shows, anime), but only for a
kind whose activity stamp at `/sync/activities` has moved since it was last
fully applied. A kind is fetched whole the first time and with `date_from`
after that, which is what Simkl asks of a client that keeps in step: only
what changed since the stamp its last applied fetch was made under. Once a
week the fetch that is due anyway is whole again, in case an incremental
answer left something out. A kind Simkl gives no stamp for is read once a
day, not on every pass.

If the activities request fails, nothing is fetched and it is tried again
after a pause that lengthens up to an hour; a 401 or 403 stops the
catch-up's own Simkl requests until this device is linked again or six
hours have passed, whichever comes first (the half-hourly background sync
asks again every six hours too, and the history pushes are separate and
keep trying). A kind whose fetch or write fails waits out its own, longer,
pause without holding up the others, and a kind that was fetched but could
not be placed in full (an id lookup nobody could answer) is left ten
minutes. Those pauses belong to the account and profile that earned them. A
Simkl library answer cut off part way counts as a failure, never as an
empty one, as a cut-off Simkl plan list does (rule 5). Anime waits until the
catalog has been organised into its seasons, and is asked for again a few
minutes later.

None of these pauses, nor the half-hourly sync's own ("When Simkl's lists
are read"), survives a restart. Restarting the app, or reopening the phone
or TV app from scratch, clears all of them, a refused sign-in included. The
catch-up then asks Simkl again as soon as the app opens, and the
half-hourly sync about four minutes later. What has already been read is
kept, so this costs one small request, not a fresh read of every list.

**It only ever adds viewings.** It writes those this device has no record
of, however the Simkl library looks. A viewing already held here is
skipped rather than written again, because this device's own viewing
comes back from Simkl stamped differently and would otherwise appear as a
second play. Each title's state at Simkl is remembered, and a title that
has not changed since is left entirely alone. Only a film Simkl lists as
completed is taken; one that is only planned there is not a viewing. A
film taken as watched that is still on the plan here comes off it, as in
rule 8: Trakt is told when "Keep watchlists in sync" is on, and Simkl and
MAL are not asked to remove anything. A film already watched here that is
on the plan stays there, as a plan to watch it again, and so does one
whose un-watch here is still owed to Simkl.

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
phone or TV is followed the same way once an episode of it counts as
watched (80% of the way through), not when Play is pressed. Specials
(season 0) do not count, and a title with only one playable episode, such
as an anime film or a lone special, is not followed. A later season of a
merged anime follows the show it belongs to.

**Taking a followed show off the list** (Remove from My List on the phone;
Remove from plan, or Remove on its Continue Watching card, on the desktop)
works like any other un-plan. The catch-up does not follow it again until a
viewing of it made somewhere else arrives while Simkl lists it as watching.
A changed count or status at Simkl on its own does not bring it back.
Watching an episode of it on the phone or TV past the 80% mark follows it
again. Rule 3 applies to the removal as it does anywhere: with viewings
recorded here, the unscoped Simkl removal is not sent.

**Posters.** A pull plans a title with only its name and year, and a follow
adds even less. After every pass with any service connected, the catch-up
looks up artwork for at most 40 titles on the list that have no poster,
and none in the catalog index either, newest first, and writes the poster
into the list's row under the row's own id. A title is asked about once
while the app runs, or up to three times while the lookup fails. So on the
phone and TV's Home, a title a pull brought in gets its poster without
waiting for the catalog's refresh. The desktop's grids, My Stuff and
Planned tab read the catalog index, and wait for it.

**Known limits.**

- It is only as good as Simkl. A viewing Simkl never recorded cannot
  arrive. An entry with no IMDb id (films and series), or no Kitsu id
  (anime), neither its own nor one found through its MyAnimeList or AniDB
  id, is skipped, not guessed. The catch-up counts these, but no screen
  shows the count. Shows are read season by season. A season whose number
  cannot be read is left out whole rather than guessed, one Simkl gives no
  number at all is taken as season 1, and episodes listed outside any
  season are not read. An episode Simkl holds without a usable date is
  left out. A finished film with no watched date is recorded at the date
  it was added to the list there, or failing that at the time of the
  catch-up.
- Through Simkl. An episode or film watched on the phone reaches Simkl
  through the ordinary history push, and the desktop's next catch-up takes
  it from there; with Simkl not connected nothing travels between the two.
- Anime takes only each Simkl entry's own first-season numbering (its
  season 1, or none). It is filed under the season of the merged show that
  entry can be shown to be, and under the entry's own id where it cannot be
  shown to be one; a show's own entry that cannot be shown to be its first
  season is skipped and counted. An episode Simkl files under season 0, or
  2 and later, is refused. The next section has the mapping, and what
  became of later seasons pushed before it existed.
- A local un-watch is not taken back in while its removal at Simkl is
  still on its way or owed after a failure (see "History pushes that fail
  are kept"). Once it has been given up on after ten tries, it can come
  back when that title next has activity there.
- A film Sync review's "Use Local" ruled not watched is not taken
  back in while that decision is still queued for Simkl, nor once the
  queue has given up on it (90 days). Taken in, the next flush would find
  both sides agreeing and pass "watched" on to Trakt, the opposite of what
  was chosen.

## Trakt's history

The "Import my Trakt library" button reads a whole Trakt account once:
every viewing with its date, and every rating. Pressed again, it adds
nothing already brought in from Trakt, but it does not skip what is held
here: a viewing played here and sent to Trakt since then comes back with
Trakt's own time and is recorded as a second play. The episode stays
watched once, but History lists it twice and play counts take it as a
rewatch. Somebody who connects Trakt and never presses it still gets their
past: the pull below runs the same import once on its first pass (see "It
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
  uses). While the anime catalog is still being organised, a pull that
  holds any anime writes nothing, the films and series beside it included,
  and tries the same rows again next time. A first pass held up this way
  reads the whole account again on each try.
- **Anime is told apart through Simkl.** Trakt has no anime category, so
  the app looks each show's IMDb id up with Simkl's id search and keeps the
  answer 30 days; a first import of a long history makes one request per
  show. The lookup needs a Simkl Client ID but not a Simkl sign-in. Without
  one, or when Simkl does not answer, an anime watched on Trakt comes in as
  a series under its IMDb id, does not show as watched on its anime page,
  and later passes do not move it.
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
  from, so the pull never reads the whole account after one. On the
  desktop, the first episode comparison against the account then takes in
  what Trakt holds of the shows held here ("Episodes, show by show").
- A viewing given to Trakt with a date older than three days before the
  last pull (a backdated entry) is not seen by the pull; the import finds
  it.
- The import reads at most 20,000 viewings, newest first, and up to 20,000
  ratings of each kind. An account with more brings in only its newest
  20,000. The older viewings are not brought in by pressing Import again or
  by the pull, and only the log says the import stopped short.
- A backup is written before it writes rows, at most once a day (see
  "When the grouping changes" for the backups).

## Episodes, show by show

Progress on a show is a set of watched episodes, here and at each service.
"Here S1E8, Trakt S2E2" is not two positions to choose between: it is the
episodes Trakt holds that this app does not (S1E9 to S2E2), and perhaps
some the other way round. So shows are compared as sets, show by show, and
nothing anywhere offers "keep S1E8 or S2E2".

The pulls above only add, so an episode a service has told this app about
is held here, apart from what they skip (see the known limits under "The
catch-up", and "Trakt's history"). What they cannot see is an episode held
here that a service does not have: a push that failed for good, a service
connected after the episode was marked. Nor could anybody see what a pull
took in, to take it back out. This is both
(`src/main/media-hub/episodeSync.ts`, tested in
`tests/episodeSync.test.ts`).

**When it runs.** On the desktop only, after the catch-up (launch, focus,
and the launch check eight seconds after the window opens) and after the
half-hourly pass. The launch check does not wait for it: the films answer
first, and what the comparison adds reaches the panel and the top bar's
button when it is done, as does what any later pass adds. A service is read
only when its activity stamp moved since the last comparison under that
account: Simkl's shows and anime stamps as the catch-up or the pass just
read them (the comparison asks `/sync/activities` nothing of its own, and
leaves Simkl alone when that answer is more than five minutes old), and
Trakt's episodes stamp as the history pull recorded it. When one moved,
that service's whole set is read once: Simkl's `shows/all` and `anime/all`
lists, each behind its own stamp and at most every six hours (see "When
Simkl's lists are read"), or Trakt's `/sync/watched/shows`, one request. A
pass where nothing moved costs nothing beyond what the pulls already asked.

**It takes the union, and only adds (rule 1).**

- Episodes held here that the service lacks are sent to it as an add, on
  the title's own push chain, so a failure is kept and retried like any
  history push. Each goes with the time it was watched here, so a backlog
  does not land as watched today; a retried push goes undated, and so does
  an anime sent to Simkl, since its numbers there are the entry's.
- Not sent: an episode marked here in the last fifteen minutes (its own
  push may still be on the way, and a second add is a second play at
  Trakt); one with a change owed to that service; one that arrived from
  that service and has since gone from it (it was removed there); and one
  already sent under the same account (still missing, it was not taken, was
  removed since, or its send was let go after ten failed tries).
- At most twenty shows per list per comparison, each one request. Simkl's
  series and anime lists are counted apart, so one comparison can send
  Simkl forty shows and Trakt twenty. A comparison that left shows over is
  recorded as partial: the service is read again on the next moved stamp,
  but not within half an hour (for Simkl too, instead of its usual six
  hours), and since the shows just sent are not sent again, the rest move
  up.
- Episodes only the service holds are already here, apart from what the
  pulls skip: the Simkl catch-up reads each kind whole the first time, and
  the Trakt pull's first pass runs the whole-account import. The first
  comparison against a Trakt account (none on record for it, or the last
  made under another mark, rule 7) also takes in what Trakt holds of the
  shows held here. It takes a backup first and leaves out any episode with
  a change owed, so anything the import missed for those shows comes in
  too. After the first, what arrives at Trakt comes in through the pull.
  Anime is never taken in this way, and Simkl never is.
- Nothing is removed, here or at any service. A local removal still holds
  (rule 6): an episode whose removal is owed or on its way is neither taken
  back in nor counted against the service.

**Rule 5 holds.** A read that failed, came back cut off, or (for anime)
held an entry nobody could be asked to look up writes nothing and records
nothing, and its stamp is left, so the next pass reads it again.

**What is compared where.**

- Series, at Simkl and Trakt, by IMDb id. A show a service holds with no
  IMDb id cannot be matched: its episodes here are sent to it once, and not
  again. Specials (season 0) are compared too: a special watched here that
  a service lacks is sent to it like any other episode.
- Anime at Simkl, entry by entry, placed by the rules every Simkl push uses
  ("Anime: one show here, an entry per season at Simkl", below): a later
  season only where `laterSeasonOf` can show its place is its season on the
  page. A member that cannot be shown to be its season keeps its whole show
  out of the comparison, since compared by position it would send the wrong
  season or report one missing. A season the rules name no entry for
  (`toSimklAnimeEpisode` gives none) is listed as **cannot be sent to
  Simkl**, not sent. An anime's specials are not compared.
- Anime is not compared at Trakt. This app never sends anime there, and
  Trakt keeps an anime under an IMDb series this app keeps under a Kitsu
  id. An anime's row says **cannot be sent to Trakt** for its seasons.
- MyAnimeList keeps a count per entry, not episodes, and is not read. When
  a choice below removes anime episodes here, the seasons it touched are
  recounted and sent (`planMalPushes`), as any change here is.

**The record of what was merged.** Per show and per service: the episodes
that arrived (from the Simkl catch-up, the Trakt pull after its first pass,
or the comparison's first Trakt take-in), the ones sent, and the ones that
cannot be sent. One durable entry per profile (`episode-sync:merged:v1`),
each service's part stamped with its account (rule 7) and inert under any
other. The same unsendable episodes found again do not bring a reviewed
row back; a different set does. Besides the rows, it keeps per show,
service and account what arrived and what was sent. A review does not
clear this; it is what the comparison goes by when it leaves out what came
from a service, or was already sent to it.

**How long it is kept.** A row leaves when it is reviewed, or 90 days after
a pass last added to it. What arrived and what was sent is kept 400 days
per show and service after anything was last added to it, while the record
is rewritten; the whole record goes if nothing rewrites it for about four
months (90 days plus 30 before the row is deleted). After that the
comparison can send back an episode removed at a service, and send once
more one the service never took. A reviewed row with the same unsendable
episodes can also come back.

The phone and TV app have no panel, but their catch-up writes this record
all the same. What is watched on the phone reaches the desktop through
Simkl, and the desktop's own catch-up records it there.

**The shows section of Sync review.** The desktop's panel lists each show
in the record as a line per side: **Here**, then each service the row has
a part for. On each line is a bubble per season showing how far that side
had got **on its own, before the merge** (worked back from what is held
here now and the row's parts): green when every episode the title's
episode list names for the season is held, by number, blue with the
episode reached when some are, grey when none are. The episode list is
fetched the first time the row is shown and kept until the app closes;
until it arrives, or when it cannot be fetched, no season is green. A
season a service cannot be sent is drawn dashed on that service's line.
Specials have no bubble. When a series row differs only in a special, every
line shows the same bubbles, but **Use** still removes or sends that
special. (The sides are worked out in
`src/shared/media-hub/showSyncSides.ts`, tested in
`tests/showSyncSides.test.ts`.)

Merging is what has already happened, so the choices are the ways back,
each a **Use** button beside a side, and the x:

- **Keep** (the x): the merge stands, and the row goes.
- **Use** beside **Here** (undo): the episodes that arrived are removed
  here, at the service they came from, and at any service the comparison
  passed them on to, so every side is back to what was held here.
- **Use** beside a service (make here match it): this app ends up with
  that service's set. What was held here and not there is removed here,
  taken back from the service where the comparison had sent it, and
  removed at the other service as well, except what this app saw arrive
  from that other service. That one was recorded there by itself, not put
  there from here, and like a planned title (rules 2 and 3) a removal only
  goes where this app put the thing. What arrived from the service is sent
  on to the other service (rule 1).

Within the episode merge these are the only removals at a service, and each
is somebody's decision about one show. (Un-marking an episode, a season or
a title here removes it at the services too; see rule 8's last paragraph.)
Every removal names its episodes; a show reference never goes out without
them (rule 3: at Simkl a bare one removes the show's whole history). What a
choice cannot send, a season with no entry or anime to Trakt, is said, and
left as it is there. Where that is **Use** beside **Here** for episodes that
came from that service (Trakt's viewings the pull filed under an anime
here), the service's pulls leave those episodes out for 30 days, long
enough for the Trakt pull's three days of overlap to pass, so the undo is
not taken back in.

**A choice stands once made.** It is written down before anything changes:
the changes for the services go into the same durable record as a failed
history push ("History pushes that fail are kept"), stamped with the
account; then the row leaves; then the episodes are removed here, after a
backup at most once a day. A choice that cannot be written down changes
nothing and says so. The changes go out three seconds after the last
choice with the other owed pushes, one request per service, title and
direction, and again with every half-hourly pass and **Sync now** until
they land, on that record's terms: ten tries, offline tries free, let go
after 30 days. The shows' changes are history pushes and are kept like the
others. A push that fails does not bring the row back, or the episodes
back here. While a removal is owed, the catch-up, the Trakt pull and the
comparison do not take that episode back in from that service.

**Known limits.**

- What was taken in before rows were kept, and what the Trakt pull's first
  pass and the Import button take in, is not recorded as arrived. It has no
  row and cannot be undone from the panel.
- An episode a second service already held before the merge stays there
  after **Use** beside **Here**: nothing recorded it as that service's. The
  comparison does not take it back in, but the Simkl catch-up does the next
  time that show changes at Simkl (rule 1), and it arrives as a new row.
- A show held only at Trakt is not taken in by the comparison; it comes in
  with the import ("Trakt's history").
- **Use** beside a service cannot tell a viewing the other service recorded
  on its own, before rows were kept, from one this app put there, and
  removes it there.

## Anime: one show here, an entry per season at Simkl

This app merges a franchise's seasons into one show. Watch history is kept
under the Kitsu id of the member that fronts the show (usually its first
season; see "When a member's place is not its season", below), numbered as
the show's page numbers its seasons; only on a show numbered by its members
is season 2 always the second member. Simkl, like MyAnimeList, keeps an
entry per season, each numbered from episode 1, and an anime id names one
of those entries.

So every anime episode sent to Simkl (a mark, an unmark, a whole season, a
whole title, a scrobble) is translated first, by `toSimklAnimeEpisode` in
`src/shared/media-hub/serviceIds.ts`:

- Season _s_, episode _e_ of a merged show goes out as episode _e_ of the
  member that is season _s_, under that member's own Kitsu id and with no
  season number. A change that spans seasons is one entry per season, the
  same split `planMalPushes` makes for MAL.
- Which member that is, is the group's _s_-th, but only where it can be
  shown to BE season _s_ of the page (see "When a member's place is not its
  season", below). Otherwise the season is not sent. That goes for the
  first season as well: the show's own id is its first season's entry only
  where that can be shown.
- A title that was never merged is its own entry.
- Specials (season 0) are not sent. They are TMDB's list for the whole
  franchise and belong to no entry this app can name.
- A season the group has no member for is not sent.
- While the anime catalog is still being organised into its seasons, only a
  first season is sent. A later one is skipped rather than queued. It
  reaches Simkl when it is next marked or, on the desktop, with the next
  episode comparison against Simkl ("Episodes, show by show"); a missed
  un-mark does not.
- A later season's entry is named by its id alone. The title and year in
  hand are the show's, and Simkl matches on those when it cannot place an
  id, which would land on the first season.
- No entry goes out without its episodes. At `/sync/history/remove`, an
  anime reference that names none removes that entry's whole history.

**MyAnimeList** is sent a count per entry, season by season, by the same
rule. Whether the count also sets the entry's status depends on whether a
total goes with it:

- A merged show: one episode marked or un-marked, one finished in the
  player, or a whole season marked sends that season's count with no
  total, so its status is left as it was. Marking the whole title watched,
  once its episode list has loaded, sends each season's total and so sets
  watching or completed.
- An anime that is not merged is one entry. A mark or un-mark on the
  desktop (detail page or player) carries the title's total, so a single
  episode sets watching or completed. The phone and TV hold no MyAnimeList
  sign-in, so nothing marked there is sent to it.
- Clearing the whole title sends each touched season a count of 0, with
  plan_to_watch when the title is on the plan here and no status otherwise.

MyAnimeList is not held back while the catalog is being organised. In that
window a merged show is one entry, and its first season's entry is sent the
count of every episode watched in the show, all seasons together; it is put
right the next time the first season changes here.

The catch-up reads the same mapping backwards (`placeAnimeEntry` in
`animeSeasons.ts`, then `animeEntryTarget` in `serviceIds.ts`): episode _e_
of an entry is kept under the show that entry's Kitsu id belongs to, at the
season it can be shown to be there. `tests/simklAnime.test.ts` runs
`toSimklAnimeEpisode` and its inverse round trip, and through the
catch-up's own rules.

**Not verified against Simkl or MyAnimeList.** The request shape is the one
Simkl's anime guide gives for an anime id: an `anime` entry with a flat
`episodes` list. The tests model an account that behaves as that guide
says. No request has been made to either live API from a development
machine, so whether the services file these as described is still to be
confirmed on a real account.

### When a member's place is not its season

A merged show's page, and so its history, is numbered in one of two ways
(`buildGroupedAnimeVideos` in `animeSeasons.ts`):

- A show whose first member has no TheTVDB mapping is built from its
  members in order. Season _N_ is member _N_.
- A show whose first member has one is numbered by TMDB. Season _N_ is
  TMDB's season _N_, whichever member sits at _N_.

On a show numbered by TMDB, a member can be shown to be a season of the
page only when all of this holds (`animeSeasonMembers` in `serviceIds.ts`,
read from the cached mappings with no request):

- Its own TheTVDB season, in the show's series, is the place it sits at. A
  later season Kitsu has no mapping for breaks it. So does an entry of
  unknown kind among the seasons, which is still grouped as one ("Films,
  OVAs and specials are not seasons", below). A member of another series
  never is one: Naruto is the second member of the Naruto: Shippuden
  group.
- No other member maps to that season. Two cours of one TheTVDB season
  share its episode numbers between them, and nothing says which cour has
  which.
- Every member of the show has been looked up. One nobody asked about could
  be that same season.

That applies to the first member too. A show can be fronted by something
that is not its first season: a recap, a second season whose first was
never crawled, one half of a first season. Season 1 of its page is still
TMDB's first season, and the show's own id is not that season's entry.

Everything that turns a member into a season of the show, or a season into
a member, asks this first. `animeSeasonMembers` answers which member is
each season and `animeSeasonOfMember` is its inverse;
`tests/simklAnime.test.ts` runs them round trip, and
`tests/animeEntryPlacing.test.ts` runs every path's own lookup against a
database. Where it cannot be shown, nothing is written or sent by a
member's place. What happens instead:

- **Marks and scrobbles sent to Simkl, and the count sent to MyAnimeList.**
  A season no member can be shown to be is not sent. A later member that
  cannot be placed is, opened by its own id, an entry of its own, as a
  title that was never merged is: Simkl is told its episodes under its id,
  and MyAnimeList the count of the rows under its id.
- **The catch-up, on every device.** A Simkl entry that cannot be placed is
  kept under its own id, at season 1. The show's own id, when it cannot be
  shown to be the first season, is skipped and counted.
- **The MyAnimeList import.** An entry that cannot be placed is compared
  with, and written under, the rows of its own id: every row under it,
  whatever season its own page labels them, which is the count the push
  sends for it. The show's own id, when it cannot be shown to be the first
  season, is listed with the unmatched entries, and nothing is pulled or
  pushed for it. A rating follows the entry: under the show for a season of
  it, under its own id otherwise.
- **The Trakt import.** A later member that cannot be placed is kept under
  its own id with Trakt's season numbers, as a title that was never merged
  is, and so is a rating of it. The show's own id is the show either way:
  Trakt numbers a show's seasons itself, and they are filed under the show
  as they came.
- **The episode comparison on the desktop.** A Simkl entry that cannot be
  placed is left out of the comparison, together with the show it would
  have landed on: nothing is taken in or sent for either. That goes for a
  show's own id that cannot be shown to be its first season as well.
- **A page or a card opened by a later member's own id** opens and saves as
  itself, and its rows are not moved under the show.
- **Home.** A tracked later member that cannot be placed is counted from
  the rows under its own id, never from the show's rows at its place.
- **The Anime library.** A later member that cannot be placed keeps its own
  tile, and its badge and the Hide watched and Hide completed filters read
  the rows under its own id. Episodes of it watched from its tab on the
  show's page are kept under the show and do not mark that tile, so Hide
  watched leaves it on the grid.

One caller asks less, and sends nothing on the answer. When a show comes
apart ("When the grouping changes", below), there is no grouping left to
ask about a place in, so its rows go to the one former member whose own
TheTVDB season they are filed at, wherever it sat (`animeTvdbSeasonIs`,
through `regroupPlaceIsSeason`). Of the grouping that stands, the regroup
asks the same rule as everything else.

Kept under its own id is the safe choice wherever that id has a page of its
own, which every later member that cannot be placed has: the viewing is
seen there, and the same episode sent back goes to the same entry. The
show's own id has no such page (it opens the show), so there is nowhere to
keep an entry that is not the show's first season, and it is left out.

In one real library of 301 merged shows, 233 are numbered by TMDB. 286 of
698 later seasons can be shown to be a season of their show, and 280 of the
301 shows can be shown to be fronted by their first season. That was
measured on a catalog grouped while films and OVAs were still members; with
them out, fewer places are off.

**What this leaves out.**

- Rows already filed by place (by the catch-up, the MyAnimeList import or
  the Trakt import before this rule) are not moved. Nothing tells them
  apart from rows marked on the show's page.
- A member whose TheTVDB season is _N_ but which sits at another place is
  not taken as season _N_, though it probably is. Where TMDB has no season
  _N_ the page fills it from the member at place _N_, and nothing cached
  says which the page did. In the same library this would place 10 more
  later seasons.
- Two cours of one season could be told apart by their episode counts and
  air order. They are not: both stay unplaced.
- A single entry that TMDB splits into several seasons (Naruto: Shippuden
  is one entry of 500 episodes and many seasons on its page) is the page's
  first season by this rule. Its episodes past the end of that season have
  no row the page reads.
- An install with no TMDB key builds every page from its members. The rule
  still treats a show whose first member has a TheTVDB mapping as numbered
  by TMDB, so it places fewer members than it could there.

### Films, OVAs and specials are not seasons

Kitsu says what kind of entry each anime is: a TV series, a film, an OVA,
an ONA (a web release), a special or a music video. The grouping reads it
(`normalizeKitsuAnime` keeps it as `subtype`), and only TV entries become
seasons of a merged show. Merged in as a numbered season, a film would take
a season's place, push the seasons after it one place along, and, since
TheTVDB files films at season 0, could sort first and front the show,
leaving no later season provably at its place.

- A film, OVA, ONA, special or music entry stays a title of its own, with
  its own page, its own rows and its own Simkl and MyAnimeList entry. It is
  still listed in the franchise guide, and the show's page lists it between
  the seasons it came out between, by Kitsu's start dates (`groupedExtras`
  and `seasonStarts` on the show's catalog entry).
- It still links the seasons on either side of it. A first season whose
  only recorded sequel is a film, and the film's own sequel the second
  season, are one show of two seasons.
- An entry whose kind is not known is grouped as a season.
- A show whose real seasons Kitsu lists as ONAs, OVAs or specials comes
  apart: each such season is a title of its own. Kitsu's kind is the only
  signal used, and telling which web releases are seasons would be a guess.
  A franchise left with fewer than two TV entries is not a merged show at
  all: its one TV season and everything linked to it keep their own tiles
  and pages.

A film or OVA leaving a show reaches watch history the way any change of
grouping does ("When the grouping changes", below). On a show numbered by
its members, the rows kept for a film at its season go back under the
film's own id, and the seasons after it close the gap. On a show numbered
by TMDB, the rows were TMDB's seasons and stay at their numbers; where the
film fronted the show, they move to the id that fronts the series now.
Where the film fronted a show of one season, there is no show left: that
season's rows go to the season's own entry.

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
index keeps a row for every season, so the library's query leaves out
every id that is a later season of a merged show, in the same statement
that counts the total, on the desktop and on the phone. Search leaves those
rows out of its index half, and a Kitsu hit for a later season is answered
with its show, in the place the season would have taken, so a season's own
name still finds something. The index alone never returns a later season,
so when Kitsu does not answer in time the season's own name does not find
the show. Only the seasons whose place is their season on the show's page
are left out: any other member still opens as itself, and its tile is how
it is reached. A plan card under a later season's id is read by id and
still shows.

With the later seasons gone, Hide watched and Hide completed (on the
desktop; the phone's grid has neither) read every tile that is left by its
own id. For a show's own tile that is every season kept under it: one
watched episode of any season hides it with Hide watched on, including a
later season watched from its plan card.

Recommendations go by membership, not by place. The suggestion row and the
For You shelves draw on the index as well as the catalog, and the index
keeps a row for every member of a merged show, and a later season offered
as a title of its own could be one already watched to the end (its
viewings are under the show, not under the id that was checked). So no
member is offered, and the show's own row is the one that competes for a
place. A member is dropped as a candidate, dropped again when a stored
list is read, and is not offered as what comes next either: the next season
of a merged show is inside the show. This is every season of a merged show,
not only the ones whose place is their season, since nothing here acts on
the place. A film, OVA, ONA or special is not a member ("Films, OVAs and
specials are not seasons", above): it is a title of its own and can be
suggested like any other, including as what comes after the show's last
season. An entry of unknown kind is still a member.

Home follows the same split. On the phone and TV, Plan to Watch shows a
merged show once: a later season on the plan gets its own card only when
the show itself is not on the list, and while the show is on the list with
nothing aired left to play, a planned later season that has not aired yet
is in neither Plan to Watch nor Continue Watching until its first episode
airs. On the desktop, Home's Planned tab lists everything on the plan, so
the season's card sits beside its show's card, even after the season is
started. On both, once an episode of the season has been watched, the show
takes its place in Continue Watching.

Rows saved under a later season's own id while it opened as a one-season
title of its own are not read by the show's page, and the count sent to
MyAnimeList (read from the show's rows) leaves them out. They are moved
under the show once, in the background, after the anime catalog has been
organised (`animeSyncRepair.ts`). Nothing is sent to a service when they
move; MyAnimeList hears the right count the next time that season changes
here.

Until the catalog has been organised into its seasons, nothing can tell a
later season from a title that stands alone. That is true on a fresh
install, and again after every crawl of the anime catalog for the few
minutes the grouping takes (longer while something plays). In that window a
later season opens and saves as itself, the Anime library and search list
every season as a tile of its own, and recommendations leave no member out;
a stored list that holds one is ranked again once the catalog is organised.
The library is told when the crawl lands but not when the grouping does
(unless rows moved), so an open grid keeps its per-season tiles until it is
loaded again.

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

The rows are not left behind if the app closes, or the move fails, before
they follow a new grouping. A background check compares the grouping with
the ledger every hour and makes the move then; it shows as "Repairing anime
watch history" in Background Activity. Its first run is about eight minutes
after launch, and it waits while something is playing. When the grouping
matches the ledger it does nothing and writes no backup.

What moves depends on how the show's page numbers its seasons:

- **A show with no TheTVDB mapping** is numbered by its members: season 3
  is the third member's episodes. Its rows follow their member. A new
  front, a new order, a member leaving (its season goes back under its own
  id) and a member joining are all followed. What belongs to the whole show
  rather than to one season goes where the old front id went: its specials
  at season 0 (a Trakt import files them there) and its rating. If that id
  is in no show any more (a film that used to sort first), they go to the
  one show the rest of its seasons are in. If the rest went to more than
  one show, or the show they went to now has a TheTVDB mapping, they stay
  where they are. A rating the show already has is kept, and the arriving
  one is dropped.
- **A show with a TheTVDB mapping** has its page filled from TMDB: season 3
  is TMDB's season 3, whichever member sits third. A member changing place
  does not change what season 3 shows, so its rows stay at their numbers.
  Only a new id in front is followed, with the season numbers kept, and
  only when both ids map to the same series. That includes a front that is
  in no show any more (a film that used to sort first), when the rest of
  its show is all fronted by one id of the same series.
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
  it, so those rows and its rating move to the show at its season. This
  happens only on a refresh whose grouping differs from the one on record.
  A season whose place becomes its season only because its own TheTVDB
  mapping arrived (a new season that Kitsu maps late), with the members and
  their order unchanged, opens as the show from then on, but what was saved
  under its own id stays there, and the show's page does not show it.
- **Anything else is left where it is.** A show that lost its TheTVDB
  mapping between two runs keeps its rows at their numbers, and so does one
  that gained a mapping. A show whose lookup has never answered keeps them
  too, and a new front that cannot be shown to be the same series is not
  followed.
- **A title that stood alone and joins a show as a later season** is moved
  under the show only where its place is its season on the page ("When a
  member's place is not its season", above). On a show numbered by TMDB
  that is often not so: a later TV season Kitsu has no TheTVDB mapping for,
  or two cours that share one TheTVDB season. Such a title still opens and
  saves as itself, and keeps its rows.

The log names what is left where it is, once, on the refresh that changed
the grouping, as `anime:regroup <id> left where it is: <why>`: a member
whose place changed on a show that gained a mapping, a new front that
cannot be shown to be the same series (on a show whose lookup never
answered, that is any new front), and a show numbered by TMDB, or one whose
lookup never answered, that came apart. A lost mapping is not named.
Nothing is guessed, because a wrong move would put rows on another
season's, where the ones already there win and the arrivals are dropped.

The plan is not moved. A planned title keeps its own id whatever the
grouping does, for the reason given above.

A moved viewing keeps the title and poster it was saved with, so My Stuff's
History can show a season's own name, or the poster of the id that used to
front the show. A followed show's "new episodes since" marker is a season
and episode number and is not moved either, so after a show numbered by its
members is re-ordered it can count from another season. A refresh whose
lookups fail can split a show numbered by its members for a few hours: its
seasons then move out under their own ids, and back when the show re-forms.
Each split and re-form moves the rows twice, and each move writes a backup
(below).

A row already at the place a move lands on is kept, and the arriving copy
of that episode is dropped. Plays are all kept, except a viewing already
there at the same instant.

A backup carries the ledger, and a restore puts it back with the rows, so
rows restored after the grouping has moved on are brought to where it is
now. A backup from before the ledger has none; its rows are taken to be
filed the way the install's own are.

Before the regroup or the repair moves any rows, the app writes a backup of
the whole library into a `backups` folder in its data folder
(`autoBackup.ts`). So do the Trakt import, the Trakt pull (at most once a
day), and the MyAnimeList apply before they write, and the desktop's
episode comparison (at most once a day, before it takes episodes in and
before a Sync review choice removes them here). The regroup writes one
whenever a change of grouping calls for moving rows or a rating, whether or
not anyone has watched the shows involved, and does not space them out; a
change that moves nothing, such as a re-order of a show numbered by TMDB,
writes none.

These are ordinary backups that **Restore** reads. Each one written is a
line in the log, and one that cannot be written is logged and does not
stop the step. The newest five are kept, shared by every step, so a show
that keeps splitting and re-forming can push out a backup taken before a
Trakt import or a MyAnimeList apply.

**Rows from before the ledger.** The first run only records the grouping;
it has nothing to compare it with. An id that fronted its show before then
and is a later season now still holds the whole show's rows, in an order
nothing recorded. The repair places them once, where the old order can be
shown rather than guessed:

- Its own season is placed (it was the first), but only where its place in
  the show is its season on the show's page.
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

What cannot be placed stays under the old id, and the log names it. An id
whose place is not its season on the page is not touched at all: its rows
stay under it, it still opens as itself, and the log does not name it. That
includes every later season of a show whose first season has never been
looked up on TheTVDB when the repair runs, and, on a show numbered by TMDB,
every member whose TheTVDB season is not its place.

**Not covered.** On a show numbered by TMDB, the page and the services
disagree about a season number wherever the members are not exactly the TV
seasons in order (a TV entry with no TheTVDB mapping, or one TMDB season
that Kitsu splits in two; a film or an OVA is no longer a member): the page
shows TMDB's season, and the member at that position is something else.
Such a season is not sent to Simkl or MyAnimeList at all ("When a member's
place is not its season", above), and it is why such a show's rows are not
moved by member. The regroup makes the same assumption on an install with
no TMDB key (the last item of "What this leaves out", above): a change in
the order of such a show's seasons moves nothing, so its watched episodes
can show against the wrong season until the order changes back.

### Pushes made before the mapping

Before the mapping, a later season went out under the first season's id
with a season number. Simkl most likely filed it as that episode number of
the first season, or dropped it.

- **Nothing is removed.** An episode Simkl misfiled is still on the first
  season's entry. The app cannot tell it from a first-season episode
  watched somewhere else, so it leaves it alone, and it stays until it is
  removed at Simkl by hand. Un-watching the episode here asks only its own
  entry.
- **The desktop sends the missing ones again; the phone does not.** On the
  desktop, the episode comparison ("Episodes, show by show") finds
  later-season episodes held here that their own entry at Simkl lacks, and
  sends them there, up to twenty shows a pass and each episode once per
  account. They go undated, so Simkl records them as watched on the day
  they are sent, and those shows appear in Sync review as sent to Simkl. A
  season that cannot be shown to be its member is not sent. The phone and
  TV app run no comparison, so there such an episode reaches its entry only
  when it is marked again. Mark season watched sends the whole season
  again; setting the title to Watched sends only episodes not yet held
  here, so it does not.
- The catch-up keeps its guard: a first-season episode at Simkl is skipped
  when this device holds the same episode number under a later season and
  not under the first. That is what stops this device's own old pushes
  coming back as season 1.
- A device that never held the later-season row (a phone linked
  afterwards, or one where the episode was since un-watched) has nothing
  to recognise a misfiled episode by, and takes it as a first-season
  viewing.
- The guard has a cost: a first-season episode really watched somewhere
  else is skipped for as long as this device holds that episode number
  under a later season only.

## Where it is kept

The plan's own records (`planned:origins`, `planned:pending-removals`,
`planned:sources`) are one record for the whole install, shared by every
profile: an origin a pull wrote while one profile was active counts in
every other. The records below are kept per profile, in the library
database's cache table:

- `history:pending-pushes:v1`: history changes still owed (30 days after
  its last change).
- `simkl:watch-sync:v1` and `simkl:catch-up:v1`: Simkl's stamps as last
  read and applied (400 days).
- `trakt:history-pull:v1`: where the Trakt pull carries on from (400 days).
- `episode-sync:merged:v1`: the Sync review's shows (90 days after it was
  last written).
- `episode-sync:compared:v1`: the stamps each comparison was made under
  (400 days).
- `reconcile:result:v2`: the last films comparison (a day).
- `reconcile:ignored:v1`: the films Sync review was told to stop asking
  about (90 days after it was last written).
- `reconcile:pending:v2`: the films' "Use Local" choices still to be sent,
  stamped with the Simkl account (90 days after it was last written).
- `reconcile:abandoned:v1`: the films whose "Use Local" was given up after
  five tries, for one Simkl account (90 days after it was last written).

A record that cannot be read counts as never written. A row is deleted 30
days after it expires.

## How to undo it

Turn off **Keep watchlists in sync** in the Watchlists panel (Control
centre → Accounts → Tracking). It covers the plan to watch only. Plans are
still pulled in, but nothing planned or un-planned here is sent, owed plan
removals wait, and a title that leaves a service stays here. An un-plan
made while it is off holds nothing back, so a title still on a service's
list is planned here again by the next pull (rule 4): within half an hour
for Trakt and MyAnimeList, at the next read of Simkl's lists for Simkl. The
origins record is kept, so turning it back on resumes rather than
restarting.

Watch history is not covered by this switch. Marks and un-marks are still
sent and retried, and the catch-up, the Trakt history pull and the episode
comparison, which sends episodes to Simkl and Trakt, keep running. To stop
those for a service, disconnect it under Accounts.
