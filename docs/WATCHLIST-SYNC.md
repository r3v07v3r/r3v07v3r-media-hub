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

## What this deliberately does not do

- **No merging of what a "list" means.** Trakt's watchlist, Simkl's
  plantowatch and MAL's plan_to_watch are treated as the same list. They
  are not quite: Trakt's watchlist holds seasons and episodes too. Only
  film and show entries participate.
- **No custom lists.** Named lists somebody built by hand are a separate
  feature, read-only first.
- **No history.** This is plan-to-watch only. Watch history has its own
  reconcile queue with its own review UI, and the two should not be
  confused for each other.

## How to undo it

Turn off "Keep watchlists in sync" in Settings → Accounts → Watchlists.
Pulling continues; nothing is pushed and nothing is removed locally. The
origins record is kept, so turning it back on resumes rather than
restarting.
