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
  is fetched when the films stamp moved, or when the set of films watched
  here changed (a film marked here whose push to Simkl failed moves only
  this side), and only if the app's interface has asked for that panel
  since it started. The phone and TV app never do, so there it is never
  fetched.
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
the two-minute wait. All of that is per profile: a pass for one profile
never answers for another, which gets its own.

**What it reads.** First the watchlist pull above, so the plan is settled
before any history lands: the pull refuses to plan anything with local
history, so the other order would refuse a title for a viewing the same
pass wrote. Simkl's lists are skipped in that pull if they were already
read under the same activity stamps ("When Simkl's lists are read", above).
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
- One direction. The desktop still does not take in episodes watched on the
  phone. Those reach Simkl through the ordinary history push; a film then
  shows up in the desktop's review panel, and an episode does not reach the
  desktop at all yet.
- Anime takes only each Simkl entry's own first-season numbering (its
  season 1, or none). It is filed under the season of the merged show that
  entry can be shown to be, and under the entry's own id where it cannot be
  shown to be one; a show's own entry that is not its first season is
  skipped and counted. An episode Simkl files under season 0, or 2 and
  later, is refused. The next section has the mapping, and what became of
  later seasons pushed before it existed.
- A local un-watch whose removal at Simkl failed can come back when that
  title next has activity there.

## Anime: one show here, an entry per season at Simkl

This app merges a franchise's seasons into one show. Watch history is kept
under the first season's Kitsu id, and "season 2" means the second member
of that group. Simkl, like MyAnimeList, keeps an entry per season, each
numbered from episode 1, and an anime id names one of those entries.

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
belongs to, at the season it can be shown to be there. `tests/simklAnime.test.ts`
runs the two round trip, and through the catch-up's own rules.

**Not verified against Simkl or MyAnimeList.** The request shape is the one
Simkl's anime guide gives for an anime id: an `anime` entry with a flat
`episodes` list. The tests model an account that behaves as that guide
says. No request has been made to either live API from a development
machine, so whether the services file these as described is still to be
confirmed on a real account.

### When a member's place is not its season

"Season = the member's place in the group" is true of history, and not
always of the page. A merged show's page is numbered in one of two ways
(`buildGroupedAnimeVideos` in `animeSeasons.ts`):

- A show whose first member has no TheTVDB mapping is built from its
  members in order. Season _N_ is member _N_.
- A show whose first member has one is numbered by TMDB. Season _N_ is
  TMDB's season _N_, whichever member sits at _N_.

On a show numbered by TMDB, a member can be shown to be a season of the
page only when all of this holds (`animeSeasonMembers` in `serviceIds.ts`,
read from the cached mappings with no request):

- Its own TheTVDB season, in the show's series, is the place it sits at. A
  film or an OVA among the seasons, or a later season Kitsu has no mapping
  for, breaks it: My Hero Academia's fourth season is the group's seventh
  member, and season 7 on its page is TMDB's seventh. A member of another
  series never is one: Naruto is the second member of the Naruto: Shippuden
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
- **The catch-up on the phone and TV app.** A Simkl entry that cannot be
  placed is kept under its own id, at season 1. The show's own id, when it
  cannot be shown to be the first season, is skipped and counted.
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
- **A page or a card opened by a later member's own id** opens and saves as
  itself, as it did before, and its rows are not moved under the show.
- **Home.** A tracked later member that cannot be placed is counted from
  the rows under its own id, never from the show's rows at its place.

Kept under its own id is the safe choice wherever that id has a page of its
own, which every later member that cannot be placed has: the viewing is
seen there, and the same episode sent back goes to the same entry. The
show's own id has no such page (it opens the show), so there is nowhere to
keep an entry that is not the show's first season, and it is left out.

In one real library of 301 merged shows, 233 are numbered by TMDB. 286 of
698 later seasons can be shown to be a season of their show, and 280 of the
301 shows can be shown to be fronted by their first season.

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
  every grid such a card appears in — the plan, My Stuff, search results and
  the Anime library, whose index keeps a row for every season. The side
  panel names the episode Play will start, from the same viewings.

One thing does not follow it yet. The library's Hide watched and Hide
completed filters are applied inside the index query, by the row's own id,
so a finished later season is marked as watched in the Anime library but is
not filtered out of it. My Stuff filters after the badge is worked out, and
does hide it.

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
  only when both ids map to the same series.
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
seasons in order (a film or an OVA among them, or one TMDB season that
Kitsu splits in two): the page shows TMDB's season, and the member at that
position is something else. Such a season is not sent to Simkl or
MyAnimeList at all ("When a member's place is not its season", above), and
it is why such a show's rows are not moved by member.

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
