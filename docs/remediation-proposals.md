# Remediation proposals

This queue captures follow-up work found while reviewing the end-to-end browsing,
detail, playback, party, downloads, and settings flows. It is intentionally scoped
as pick-up-ready remediation rather than mixing larger speculative changes into a
bug-fix patch.

## P0 — make failures actionable

1. **Unify asynchronous action errors.** _Partly done._ Several renderer actions
   intentionally discard rejected IPC promises. Route them through a shared action
   runner that reports a concise toast, logs technical context in the main process,
   and offers a retry for safe idempotent operations. Acceptance: no user-triggered
   settings, update, playback, or party action can fail without visible feedback.
   The runner exists — `src/renderer/src/hooks/useAsyncAction.ts` (a toast, an
   `[action:<scope>]` console log, an optional Retry) — and is used by
   `SettingsPage.tsx` and `useUpdateManager.ts`. Still to do: the provider actions
   in `routes/MediaHubSettingsSections.tsx`, and the playback and party actions
   that end in `.catch(() => {})`, such as `components/party/PlayerSessionRail.tsx`,
   `SessionHub.tsx` and `RoomsSection.tsx`.
2. **Add bounded response-body reads to every main-process HTTP client.** The proxy
   timeout fix in this patch should become a shared fetch primitive used by catalog,
   tracking, subtitle, and metadata clients. Acceptance: a server that sends headers
   and then stalls its body cannot leave any request pending beyond its deadline.

## P1 — preserve task context

1. **Introduce a first-class not-found screen.** This patch safely returns unknown
   routes to Home; a dedicated recovery screen should explain that a link is stale
   and offer Home, Search, and Back actions. Acceptance: malformed deep links never
   show an empty shell and never discard the previous location without explanation.
2. **Persist browsing restoration across reloads.** Browsing origin is currently
   in-memory. Store only the route, scroll position, focused media ID, and timestamp
   in session-scoped main-process state. Acceptance: returning from a detail page
   after a renderer reload restores the same catalog position, while expired state
   is ignored.
3. **Give playback preparation explicit stages.** _Done._ Replace a generic loading
   state with resolving, safety-checking, buffering, and starting stages plus
   cancellation. Acceptance: every stage has a timeout, a useful failure message,
   and a single obvious next action. Built in
   `src/renderer/src/lib/mediaHub/playbackPreparation.ts`, which defines the four
   stages and the timeout and cancellation errors.

## P2 — reduce avoidable work and ambiguity

1. **Consolidate settings saves.** Debounce text-like preferences and show saved,
   saving, and failed states rather than firing unobserved IPC calls per change.
2. **Add contract tests for legacy and malformed routes.** Cover category/detail
   aliases, encoded IDs, and the catch-all route using a memory router.
3. **Measure floating overlays instead of relying on nominal dimensions.** The
   context-menu clamp now prevents off-screen placement; using its actual rendered
   rectangle would also handle localization and future menu-item additions.

## Suggested next slice

Status: started. The shared async action/error runner exists, and Settings plus
About/Update were migrated first, because those screens contain small, low-risk
operations and establish the feedback pattern. Playback and party coordination
remain.
