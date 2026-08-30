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
written when a pull adds a title, holding the service and the time.

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

### 3. A local removal pushes only where the title is

Un-planning here removes it from the services that have it, and does
nothing to the ones that do not. No service is sent a delete for
something it never held.

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

### 6. Removals are pushed once, then let go

A delete that a service rejects is retried on the ordinary schedule and
then abandoned, like the watch-history queue. It is not retried forever
against a service that has decided the title is not there.

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
