# AI development review loop

An automated Claude ⇄ GPT review cycle for this project: Claude implements against a written requirements doc, an automated QA runner and Playwright check the result objectively, GPT reviews independently against the same requirements doc (plus screenshots, diffs, and QA output) and returns structured feedback, Claude works through the approved feedback, and the cycle repeats until a quality bar is met or a fixed iteration cap is hit — at which point it always stops for a human to look at it.

It is not trying to remove you from the loop. It's trying to remove the manual tedium of: take a screenshot → copy code/results → paste into GPT → read feedback → paste feedback to Claude → wait → repeat. Human defines intent, Claude implements, automated QA verifies, GPT critiques, Claude corrects, human approves — the human decision points don't move, they just stop costing you copy-paste.

**Status in this repository:** scaffolded on 2026-07-25 and never run. `.ai/STATE.json` is still at its initial `not_started` state, `.ai/CHANGELOG.md` has no entries, no `.ai/REVIEW.md` has ever been generated, and `REQUIREMENTS.md` is still the template. Nothing in the app, its tests or CI depends on these files, so keeping or removing the loop is a workflow decision, not a code one.

## Architecture

```
.ai/
├── REQUIREMENTS.md      the current task — the only thing both agents treat as authoritative
├── REVIEW.md            latest GPT review, human-readable (regenerated each review)
├── REVIEW.json          latest GPT review, structured (regenerated each review)
├── STATE.json           iteration count, score history, issue-recurrence tracking
├── CHANGELOG.md         one short entry per loop iteration (not a diff dump)
├── config.json          thresholds, priorities, screenshot routes, model selection
├── prompts/
│   ├── reviewer.md      system prompt for the GPT reviewer role
│   └── implementer.md   instructions given to Claude when it's handed approved issues
├── screenshots/
│   ├── current/         regenerated every run (gitignored)
│   └── reference/       human-provided baseline images, compared by name (committed)
└── reports/             raw QA/screenshot JSON (gitignored): qa-latest.json plus a timestamped
                         qa-<ms>.json per run; screenshots-latest.json only, overwritten each run

scripts/
├── ai-loop.ts           orchestrator — the full iteration cycle
├── ai-review.ts         evidence collection + GPT call + REVIEW.json/.md (standalone-runnable)
├── ai-qa.ts             auto-detecting QA runner (standalone-runnable)
├── ai-screenshots.ts    Playwright screenshot + console/network capture (standalone-runnable)
└── ai-utils.ts          shared helpers: config, env, git (read-only), OpenAI client, JSON I/O
```

Git is the shared source of truth between the two agents — not chat context. Everything either agent needs to reconstruct the current task lives in `.ai/REQUIREMENTS.md`, `.ai/REVIEW.md`, and the repository itself, so the loop can be interrupted and resumed, or handed to a different session, without losing anything.

## Installing this in another project

1. Copy `.ai/` and `scripts/ai-*.ts` into the target repo.
2. `npm install -D tsx playwright` (then `npx playwright install chromium` if Playwright hasn't fetched a browser there yet).
3. Add the four `ai:*` scripts below to `package.json`.
4. Rewrite `.ai/REQUIREMENTS.md` for that project's actual current task, delete the demo content in it.
5. Adjust `.ai/config.json` — at minimum, `screenshots.routes` (or set `screenshots.enabled: false` for a non-visual project) and `screenshots.serveDir` if the build output doesn't land in `out/renderer`, `dist`, `build`, or `preview-dist` (the four directories `ai-screenshots.ts` checks on its own; nothing in this repository builds into `preview-dist` any more).
6. Add `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) to that project's `.env.local`, or export them in your shell, and make sure `.env.local` is gitignored. `scripts/ai-utils.ts` reads `process.env` and a hand-parsed `.env.local` only; a plain `.env` file is not read.
7. `git init` if the project isn't already a git repo — the loop reads `git diff`/`git status` as evidence and refuses to run without one.

Everything in `scripts/ai-utils.ts`, `ai-qa.ts` (stack auto-detection), and `ai-loop.ts`'s state machine is stack-agnostic and copyable unchanged. `ai-screenshots.ts` is copyable unchanged for any project whose build output is a static site (which covers Vite/webpack/CRA-style web and Electron-renderer builds); a genuinely different rendering model (native, server-rendered-only, etc.) would need its own capture step but can still feed the same `ScreenshotReport` shape into `ai-review.ts`.

## Commands

```
npm run ai:loop              full iteration cycle (QA -> screenshots -> GPT review -> Claude fixes -> repeat)
npm run ai:loop -- --dry-run check config/env, then RUN the detected QA commands (lint, typecheck,
                             test, build) through ai-qa.ts; zero API calls, zero code changes, but
                             it takes as long as a real QA pass and writes .ai/reports/qa-*.json
npm run ai:review            review-only mode: collect evidence, call GPT, write REVIEW.json/.md, stop
npm run ai:qa                just the QA runner
npm run ai:screenshot        just the screenshot capture
```

`npm run ai:review` is the one to reach for if you want to keep doing the implement/inspect step yourself and just want GPT's structured feedback on the current state — it never touches application code.

## Configuration (`.ai/config.json`)

| Field                                         | Meaning                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxIterations`                               | Hard ceiling on `ai:loop` iterations (default 5). The loop always stops here if it hasn't reached `approved`.                                                               |
| `approvalScore`                               | Minimum GPT score (0-100) to be eligible for automatic approval (default 90). Score alone is never sufficient — see below.                                                  |
| `autoFixPriorities`                           | Which issue priorities get handed to Claude automatically (default `P0, P1, P2`).                                                                                           |
| `requireBuildSuccess` / `requireTestsSuccess` | If true, a failing build/test run blocks approval regardless of score.                                                                                                      |
| `review.model`                                | `"${OPENAI_MODEL}"` by default — resolved from the env var at runtime so upgrading models doesn't require a code change. Falls back to `gpt-4o` if `OPENAI_MODEL` is unset. |
| `review.provider`                             | A label only. It is shown by `--dry-run` but nothing branches on it: `callOpenAI()` always calls the OpenAI endpoint.                                                       |
| `screenshots.*`                               | `enabled`, `viewport`, `routes` (`{name, url, captureOffsetsMs?}`), `serveDir` (auto-detected if omitted), `settleMs` (wait before capture).                                |
| `claude.command` / `claude.args`              | How `ai-loop.ts` invokes Claude non-interactively (default `claude -p`).                                                                                                    |

**Approval is never based on score alone.** `ai-review.ts` enforces, in code, on top of whatever GPT itself says: `status = approved` only if `score >= approvalScore` AND `P0 == 0` AND `P1 == 0` AND `P2 == 0` AND (build/test pass, per the require* flags above). GPT can be overly generous or overly harsh; this floor is a fixed backstop either way.

## Priorities

- **P0** broken / critical regression — always auto-fixed
- **P1** explicit requirement not met — always auto-fixed
- **P2** significant visual/UX/functional problem — always auto-fixed
- **P3** polish / minor improvement — auto-fixed only if low-risk and clearly required; otherwise left for a human
- **P4** optional suggestion — never auto-fixed, always needs a human decision

## Preventing oscillation

`ai-review.ts` tracks issue fingerprints (category + title) across iterations in `STATE.json.issueHistory`. If the same issue has recurred across multiple iterations without resolving, the loop is forced into `human_review_required` regardless of what GPT's own `status` field says — that pattern almost always means the two agents are talking past each other (GPT asking for X, Claude doing X, GPT asking for not-X next round) rather than converging. `prompts/reviewer.md` also instructs GPT directly not to reopen previously-accepted subjective calls without new evidence, and not to request a change and its reversal across consecutive passes.

## Human approval gate

The loop always stops rather than proceeding whenever max iterations is reached, GPT returns `human_review_required` or `blocked`, or oscillation is detected (`ai-review.ts` turns oscillation into `human_review_required`); in each of those cases it prints the summary below. A hard error (missing API key, Claude CLI not found, no git repo) stops it too, but as a thrown error with its message and a non-zero exit, not as the summary. It is never silent about why it stopped.

```
AI DEVELOPMENT REVIEW COMPLETE

Iterations: 3
Score: 94/100

P0: 0
P1: 0
P2: 0
P3: 2
P4: 1

Build: PASS
Tests: N/A
Lint: PASS

Changed files: 12

Remaining:
- [P3] <title>
- [P4] <title>

STATUS:
READY FOR HUMAN REVIEW
```

## Safety

`scripts/ai-utils.ts`'s git helpers are read-only (`status`, `diff`, `diff --stat`) — nothing under `scripts/ai-*.ts` calls a mutating git command. The scripts themselves will never: push a remote branch, merge, rewrite git history, discard uncommitted work, delete large areas of the project, reset the repository, force-checkout, remove major dependencies, change a database schema destructively, touch deployment infrastructure, expose credentials, or deploy to production. That guarantee covers the orchestrator only. In a full (non-dry-run) `ai:loop`, whenever the reviewer returns `changes_required`, the approved issues are handed to the `claude` CLI (`claude.command`/`claude.args` in `.ai/config.json`), which edits source files in the working tree under its own permission model; this framework does not sandbox it. So the loop does not discard uncommitted work, but it does add to it. All of that is why the loop stops at a human gate for anything resembling those categories instead of attempting to route around them.

## Environment variables

Set in `.env.local` (already gitignored) or your shell — not in a plain `.env`, which these scripts do not read:

- `OPENAI_API_KEY` — required for `ai:review` / `ai:loop`. `ai:qa`, `ai:screenshot`, and `ai:loop -- --dry-run` never need it.
- `OPENAI_MODEL` — optional, e.g. `gpt-4o`, `gpt-4.1`. Falls back to `gpt-4o` if unset.
- `PLAYWRIGHT_EXECUTABLE_PATH` — optional override if you want screenshots taken with a specific Chromium binary instead of Playwright's own.

## API cost

Each `ai:review` call sends: the reviewer system prompt, `REQUIREMENTS.md`, the previous `REVIEW.md` (if any), git diff/status (truncated to a few thousand characters), QA output (truncated), console/network evidence, and any current+reference screenshot pairs as images. A single review with a couple of screenshots is a few thousand input tokens plus image tokens — cheap individually, but `ai:loop` calls it once per iteration (up to `maxIterations` times), so a full 5-iteration run is 5 review calls, not 1. Use `ai:review` alone (no loop) if you just want occasional feedback without running the whole cycle.

## Troubleshooting

- **"OPENAI_API_KEY not set"** — add it to `.env.local`, not `config.json` (never put secrets in `config.json`, it's committed).
- **OpenAI API error 429 / insufficient_quota** — the key is valid but the account has no available quota/credits. Not something this framework can work around; check billing on the OpenAI account the key belongs to.
- **"playwright is not installed"** — run `npm install`; if screenshots still fail to launch a browser, run `npx playwright install chromium` once.
- **Screenshots show missing images / many failed requests to a remote host** — if you're running inside a locked-down sandbox that restricts outbound browser traffic to non-allowlisted domains (this is a known behavior of some CI/sandbox environments, unrelated to the app), image requests to external hosts can fail with `net::ERR_CONNECTION_RESET` even though the app itself is correct. Check whether the same failures occur outside the sandbox before treating them as real bugs.
- **"Not a git repository"** — `ai-loop.ts` refuses to run without one; run `git init` first.
- **"Claude CLI not found on PATH"** — `ai-loop.ts`'s final step (handing approved issues to Claude) needs the `claude` command available; if you're only using `ai:review`/`ai:qa`/`ai:screenshot`, this doesn't matter.
- **Same issue keeps reappearing across iterations** — check `.ai/STATE.json`'s `issueHistory`; the loop should auto-escalate to `human_review_required` on its own (see "Preventing oscillation" above), but if it doesn't, treat that as a bug in the oscillation heuristic, not something to keep looping through manually.

## Resuming after human review

`ai-loop.ts` reads `.ai/STATE.json`'s `iteration` field and resumes from there rather than restarting at 1, so after you've reviewed a `human_review_required` stop and made whatever call was needed (updated `REQUIREMENTS.md`, fixed something yourself, whatever), re-running `npm run ai:loop` continues the count rather than silently giving you `maxIterations` more iterations than you configured. To start a fresh cycle instead (e.g. for a new task), reset `.ai/STATE.json` to its initial shape (`iteration: 0, lastScore: null, status: "not_started", previousScores: [], openIssues: 0, issueHistory: {}`) — or just delete it; `ai-loop.ts` recreates it with those defaults if it's missing.
