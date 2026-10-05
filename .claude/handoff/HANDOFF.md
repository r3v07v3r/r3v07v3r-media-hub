# Handoff: Electron bump audit and tracking pipeline check (2026-10-05)

Temporary. This directory exists only to carry two workflow scripts from a local
session to a cloud session. Delete it before this branch is used for a pull request.

## State at handoff

Both workflows were launched locally and stopped before any agent returned, so there
are no partial results to recover. Start both again from the scripts here.

## Steps

1. Fetch the three open pull requests as local branches (the scripts refer to them):
   `git fetch origin pull/181/head:pr-181 pull/189/head:pr-189 pull/190/head:pr-190`
2. Run `electron-bump-supply-chain-audit.js` (six scanners, then two verifiers). Its
   scratch directory is `/tmp/electron-audit`. Static inspection only: nothing
   downloaded is ever installed or executed.
3. Run `tracking-pipeline-map.js` (eight read-only mappers). The owner's expected
   pipeline is written out in the script as E1 to E14.
4. When the map returns, merge overlapping claims and run a small verification pass
   over every claim that is not "matches" before reporting it.
5. Report: a short comparison of the system against E1 to E14 (where it differs, why,
   and whether it is cheaper), the Electron verdict with merge conditions, then short
   questions each with a recommendation. No code changes until the owner decides.

## Already established

- PR 181 is a security update: the Electron 39 line and its old unzip dependency have
  open advisories. The jump is five major versions.
- The checks that passed on PR 181 install with scripts disabled and never launch
  Electron, so they do not show that the app runs on Electron 44.
- Points the scan must settle: that the new `@electron-internal` scope is Electron's
  own, why the new Electron lock entry has no install script, and the Node engine
  floor of 22.12.
- PRs 189 and 190 each merge cleanly into `preview` but conflict with each other in
  four files (`animeSeasons.ts`, `tracking.ts`, and two test files). PR 190 describes
  the resolution.

## Cannot be done from a cloud session

In-app checks on the real library, anything on the home network, and the worker
deploy login. List these as "needs the local machine" rather than attempting them.
