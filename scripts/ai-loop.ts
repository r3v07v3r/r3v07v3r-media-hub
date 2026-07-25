// Orchestrator for the AI development review loop.
//
//   while iteration <= maxIterations:
//     run QA -> capture screenshots -> call GPT reviewer -> save REVIEW.json/.md
//     if approved: stop successfully
//     if human_review_required / blocked: stop for human review
//     otherwise: hand the approved-priority issues to Claude non-interactively, iterate
//   stop for human review if maxIterations is reached without approval
//
// This file deliberately never calls a mutating git command and never
// runs unbounded — maxIterations (default 5, see .ai/config.json) is a
// hard ceiling. See .ai/README.md "Safety" for the full list of things
// this orchestrator will not do on its own.
//
// Usage:
//   npm run ai:loop              full iteration cycle
//   npm run ai:loop -- --dry-run inspect config/env/commands, make zero API calls, change no code

import path from 'node:path'
import {
  AI_DIR,
  commandExists,
  countByPriority,
  gitChangedFiles,
  isGitRepo,
  loadConfig,
  loadEnvVar,
  log,
  readJSON,
  readTextIfExists,
  runCommand,
  section,
  writeJSON,
  writeText
} from './ai-utils.js'
import { runQA, type QaReport } from './ai-qa.js'
import { runScreenshots } from './ai-screenshots.js'
import { runReview, type ReviewResult } from './ai-review.js'

interface StateFile {
  iteration: number
  lastScore: number | null
  status: string
  previousScores: number[]
  openIssues: number
  issueHistory: Record<string, number[]>
}

const STATE_PATH = path.join(AI_DIR, 'STATE.json')
const CHANGELOG_PATH = path.join(AI_DIR, 'CHANGELOG.md')

function loadState(): StateFile {
  return readJSON<StateFile>(STATE_PATH, {
    iteration: 0,
    lastScore: null,
    status: 'not_started',
    previousScores: [],
    openIssues: 0,
    issueHistory: {}
  })
}

function saveState(state: StateFile): void {
  writeJSON(STATE_PATH, state)
}

function fingerprint(issue: { title: string; category: string }): string {
  return `${issue.category.toLowerCase()}|${issue.title.toLowerCase().trim()}`
}

function recordIssueHistory(state: StateFile, review: ReviewResult): void {
  const openNow = new Set(review.issues.map(fingerprint))
  for (const fp of openNow) {
    if (!state.issueHistory[fp]) state.issueHistory[fp] = []
    state.issueHistory[fp].push(state.iteration)
  }
}

function appendChangelog(iteration: number, review: ReviewResult, qa: QaReport, changedFiles: string[]): void {
  const counts = countByPriority(review.issues)
  const prior = readTextIfExists(CHANGELOG_PATH) ?? '# AI Loop Changelog\n\nConcise per-iteration summary. Full diffs live in git history, not here.\n'
  const entry = [
    '',
    `## Iteration ${iteration} — ${new Date().toISOString()}`,
    '',
    `- Score: ${review.score}/100 (status: ${review.status})`,
    `- Issues: P0:${counts.P0} P1:${counts.P1} P2:${counts.P2} P3:${counts.P3} P4:${counts.P4}`,
    `- QA: ${qa.commands.map((c) => `${c.name}=${c.success ? 'pass' : 'fail'}`).join(', ') || 'none run'}`,
    `- Files changed this iteration: ${changedFiles.length}`,
    `- Summary: ${review.summary.split('\n')[0]}`
  ].join('\n')
  writeText(CHANGELOG_PATH, prior + entry + '\n')
}

function printFinalSummary(opts: {
  iterations: number
  review: ReviewResult
  qa: QaReport
  changedFiles: number
  status: 'READY FOR HUMAN REVIEW' | 'APPROVED'
}): void {
  const counts = countByPriority(opts.review.issues)
  const build = opts.qa.commands.find((c) => c.name === 'build')
  const test = opts.qa.commands.find((c) => c.name === 'test')
  const lint = opts.qa.commands.find((c) => c.name === 'lint')
  const remaining = opts.review.issues.filter((i) => i.priority === 'P3' || i.priority === 'P4')

  const lines = [
    '',
    'AI DEVELOPMENT REVIEW COMPLETE',
    '',
    `Iterations: ${opts.iterations}`,
    `Score: ${opts.review.score}/100`,
    '',
    `P0: ${counts.P0}`,
    `P1: ${counts.P1}`,
    `P2: ${counts.P2}`,
    `P3: ${counts.P3}`,
    `P4: ${counts.P4}`,
    '',
    `Build: ${build ? (build.success ? 'PASS' : 'FAIL') : 'N/A'}`,
    `Tests: ${test ? (test.success ? 'PASS' : 'FAIL') : 'N/A'}`,
    `Lint: ${lint ? (lint.success ? 'PASS' : 'FAIL') : 'N/A'}`,
    '',
    `Changed files: ${opts.changedFiles}`,
    ''
  ]
  if (remaining.length > 0) {
    lines.push('Remaining:')
    for (const r of remaining) lines.push(`- [${r.priority}] ${r.title}`)
    lines.push('')
  }
  lines.push(`STATUS:`, opts.status)
  log(lines.join('\n'))
}

async function invokeClaude(review: ReviewResult, config: ReturnType<typeof loadConfig>): Promise<void> {
  const implementerPrompt = readTextIfExists(path.join(AI_DIR, 'prompts', 'implementer.md')) ?? ''
  const autoFixable = review.issues.filter((i) => config.autoFixPriorities.includes(i.priority))
  const issueList = autoFixable
    .map((i) => `- [${i.priority}] ${i.title}: ${i.description}\n  Suggested fix: ${i.suggested_fix}`)
    .join('\n')

  const prompt = [
    implementerPrompt,
    '',
    '## Current task',
    '',
    'Read .ai/REQUIREMENTS.md and .ai/REVIEW.md in this repository, then implement fixes for the following',
    `reviewer-approved issues (priorities ${config.autoFixPriorities.join(', ')} only — do not implement P3 unless`,
    'low-risk and clearly required, and never implement P4 without a human):',
    '',
    issueList || '(no auto-fixable issues — re-read .ai/REVIEW.md for full context)',
    '',
    review.instructions_for_claude
  ].join('\n')

  if (!commandExists(config.claude.command)) {
    throw new Error(
      `Claude CLI ("${config.claude.command}") not found on PATH. Install it, or implement the issues in ` +
        '.ai/REVIEW.md manually, then re-run npm run ai:loop.'
    )
  }

  section('Invoking Claude to implement approved fixes')
  const result = runCommand('claude-implement', config.claude.command, [...config.claude.args, prompt])
  log(result.stdout)
  if (!result.success) {
    log(result.stderr)
    throw new Error(`Claude invocation exited with code ${result.exitCode}`)
  }
}

async function dryRun(): Promise<void> {
  section('Dry run — no API calls, no code changes')
  const config = loadConfig()

  log(`Config: maxIterations=${config.maxIterations}, approvalScore=${config.approvalScore}`)
  log(`Auto-fix priorities: ${config.autoFixPriorities.join(', ')}`)
  log(`Require build success: ${config.requireBuildSuccess}, require tests success: ${config.requireTestsSuccess}`)
  log(`Reviewer: ${config.review.provider} / model=${config.review.model || '(unresolved — set OPENAI_MODEL)'}`)
  log(`Screenshots enabled: ${config.screenshots.enabled}, routes: ${config.screenshots.routes.map((r) => r.name).join(', ')}`)

  log(`\nGit repo detected: ${isGitRepo()}`)
  log(`REQUIREMENTS.md present: ${!!readTextIfExists(path.join(AI_DIR, 'REQUIREMENTS.md'))}`)
  log(`REVIEW.md present (prior review): ${!!readTextIfExists(path.join(AI_DIR, 'REVIEW.md'))}`)
  log(`OPENAI_API_KEY set: ${!!loadEnvVar('OPENAI_API_KEY')}`)
  log(`Claude CLI ("${config.claude.command}") on PATH: ${commandExists(config.claude.command)}`)

  const qaPreview = await runQA({ verbose: false })
  log(`\nDetected QA stack: ${qaPreview.stack}`)
  log(`Detected QA commands: ${qaPreview.commands.map((c) => c.name).join(', ') || '(none)'}`)

  log('\nDry run complete — no OpenAI calls were made and no files were modified beyond .ai/reports/qa-*.json.')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--dry-run')) {
    await dryRun()
    return
  }

  if (!isGitRepo()) {
    throw new Error('Not a git repository. The loop uses git diff/status as evidence — run `git init` first.')
  }

  const config = loadConfig()
  const state = loadState()
  const maxIterations = config.maxIterations
  let review: ReviewResult | null = null
  let qa: QaReport | null = null
  let iterationsRun = 0

  state.status = 'in_progress'

  for (let i = state.iteration + 1; i <= maxIterations; i++) {
    section(`Iteration ${i}/${maxIterations}`)
    state.iteration = i
    iterationsRun = i

    qa = await runQA({ verbose: true })
    await runScreenshots({ verbose: true })
    review = await runReview({ verbose: true })

    state.lastScore = review.score
    state.previousScores.push(review.score)
    state.openIssues = review.issues.length
    recordIssueHistory(state, review)
    saveState(state)

    appendChangelog(i, review, qa, gitChangedFiles())

    if (review.status === 'approved') {
      state.status = 'approved'
      saveState(state)
      printFinalSummary({ iterations: iterationsRun, review, qa, changedFiles: gitChangedFiles().length, status: 'APPROVED' })
      return
    }

    if (review.status === 'human_review_required' || review.status === 'blocked') {
      state.status = 'human_review'
      saveState(state)
      printFinalSummary({
        iterations: iterationsRun,
        review,
        qa,
        changedFiles: gitChangedFiles().length,
        status: 'READY FOR HUMAN REVIEW'
      })
      return
    }

    // changes_required — hand approved-priority issues to Claude and loop.
    await invokeClaude(review, config)
  }

  state.status = 'human_review'
  saveState(state)
  if (review && qa) {
    printFinalSummary({
      iterations: iterationsRun,
      review,
      qa,
      changedFiles: gitChangedFiles().length,
      status: 'READY FOR HUMAN REVIEW'
    })
  }
  log(`\nMax iterations (${maxIterations}) reached without approval — stopping for human review.`)
}

main().catch((err) => {
  console.error(`ai:loop failed: ${(err as Error).message}`)
  process.exit(1)
})
