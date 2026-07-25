// Collects evidence (requirements, git diff, QA results, screenshots)
// and sends it to GPT (OpenAI API) acting as an independent reviewer.
// Writes .ai/REVIEW.json (raw structured output) and .ai/REVIEW.md (a
// deterministic, human-readable rendering of that same JSON — never a
// second model call, just formatting).
//
// Runnable standalone as `npm run ai:review` (review-only mode: collects
// evidence, calls GPT, writes REVIEW.json/.md, and stops — no code
// changes, matching the manual workflow this framework is meant to
// replace the copy/paste tedium of, not replace outright), or imported
// by scripts/ai-loop.ts as part of the full iteration cycle.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  AI_DIR,
  ROOT,
  callOpenAI,
  countByPriority,
  gitChangedFiles,
  gitDiff,
  gitDiffStat,
  gitStatus,
  loadConfig,
  log,
  readJSON,
  readTextIfExists,
  section,
  tail,
  writeJSON,
  writeText
} from './ai-utils.js'
import { runQA, summarizeQaForReview, type QaReport } from './ai-qa.js'
import { runScreenshots, type ScreenshotReport } from './ai-screenshots.js'

export interface ReviewIssue {
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4'
  category: string
  title: string
  description: string
  expected: string
  evidence: string
  suggested_fix: string
}

export interface ReviewResult {
  status: 'approved' | 'changes_required' | 'human_review_required' | 'blocked'
  score: number
  summary: string
  issues: ReviewIssue[]
  approved_for_automatic_fix: string[]
  human_review_required: boolean
  instructions_for_claude: string
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'score',
    'summary',
    'issues',
    'approved_for_automatic_fix',
    'human_review_required',
    'instructions_for_claude'
  ],
  properties: {
    status: {
      type: 'string',
      enum: ['approved', 'changes_required', 'human_review_required', 'blocked']
    },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'priority',
          'category',
          'title',
          'description',
          'expected',
          'evidence',
          'suggested_fix'
        ],
        properties: {
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'P4'] },
          category: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          expected: { type: 'string' },
          evidence: { type: 'string' },
          suggested_fix: { type: 'string' }
        }
      }
    },
    approved_for_automatic_fix: { type: 'array', items: { type: 'string' } },
    human_review_required: { type: 'boolean' },
    instructions_for_claude: { type: 'string' }
  }
} as const

function issueFingerprint(issue: { title: string; category: string }): string {
  return `${issue.category.toLowerCase()}|${issue.title.toLowerCase().trim()}`
}

/** Detects issues that were open, then absent, then open again — a sign GPT and Claude are talking past each other. */
function detectOscillation(current: ReviewIssue[]): {
  flagged: boolean
  reasons: string[]
} {
  const statePath = path.join(AI_DIR, 'STATE.json')
  const stateJson = readJSON<{ issueHistory?: Record<string, number[]> }>(statePath, {})
  const history = stateJson.issueHistory ?? {}
  const reasons: string[] = []
  for (const issue of current) {
    const fp = issueFingerprint(issue)
    const iterations = history[fp] ?? []
    // 3+ separate appearances (with gaps implied by STATE bookkeeping in ai-loop) suggests a cycle.
    if (iterations.length >= 2) {
      reasons.push(
        `"${issue.title}" (${issue.category}) has recurred ${iterations.length + 1} times without resolving.`
      )
    }
  }
  return { flagged: reasons.length > 0, reasons }
}

function imageToDataUri(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  const ext = path.extname(filePath).toLowerCase()
  const mime =
    ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null
  if (!mime) return null
  const base64 = readFileSync(filePath).toString('base64')
  return `data:${mime};base64,${base64}`
}

function collectScreenshotPairs(
  screenshotReport: ScreenshotReport
): Array<{ label: string; dataUri: string }> {
  const images: Array<{ label: string; dataUri: string }> = []
  for (const route of screenshotReport.routes) {
    for (const shot of route.screenshots) {
      const currentPath = path.join(ROOT, shot)
      const dataUri = imageToDataUri(currentPath)
      if (dataUri) images.push({ label: `current — ${path.basename(shot)}`, dataUri })

      const refPath = path.join(AI_DIR, 'screenshots', 'reference', path.basename(shot))
      const refDataUri = imageToDataUri(refPath)
      if (refDataUri)
        images.push({ label: `reference — ${path.basename(shot)}`, dataUri: refDataUri })
    }
  }
  return images
}

export function formatReviewMarkdown(review: ReviewResult): string {
  const counts = countByPriority(review.issues)
  const lines: string[] = []
  lines.push(
    `# AI Review`,
    '',
    `**Status:** ${review.status}`,
    `**Score:** ${review.score}/100`,
    ''
  )
  lines.push(`## Summary`, '', review.summary, '')
  lines.push(
    `## Issue counts`,
    '',
    `P0: ${counts.P0}  P1: ${counts.P1}  P2: ${counts.P2}  P3: ${counts.P3}  P4: ${counts.P4}`,
    ''
  )
  if (review.issues.length > 0) {
    lines.push(`## Issues`, '')
    for (const issue of review.issues) {
      lines.push(`### [${issue.priority}] ${issue.title} (${issue.category})`, '')
      lines.push(`- **Description:** ${issue.description}`)
      lines.push(`- **Expected:** ${issue.expected}`)
      lines.push(`- **Evidence:** ${issue.evidence}`)
      lines.push(`- **Suggested fix:** ${issue.suggested_fix}`, '')
    }
  }
  lines.push(
    `## Approved for automatic fix`,
    '',
    review.approved_for_automatic_fix.join(', ') || '(none)',
    ''
  )
  lines.push(
    `## Instructions for Claude`,
    '',
    review.instructions_for_claude || '(none — no changes required)',
    ''
  )
  return lines.join('\n')
}

export async function runReview(opts: { verbose?: boolean } = {}): Promise<ReviewResult> {
  const config = loadConfig()
  if (opts.verbose) section('Review')

  const requirements = readTextIfExists(path.join(AI_DIR, 'REQUIREMENTS.md'))
  if (!requirements) {
    throw new Error(
      '.ai/REQUIREMENTS.md not found. Create it before running a review — see .ai/README.md.'
    )
  }
  const previousReview = readTextIfExists(path.join(AI_DIR, 'REVIEW.md'))
  const reviewerPrompt = readTextIfExists(path.join(AI_DIR, 'prompts', 'reviewer.md'))
  if (!reviewerPrompt) {
    throw new Error('.ai/prompts/reviewer.md not found.')
  }

  const qaReport: QaReport =
    readJSON(path.join(AI_DIR, 'reports', 'qa-latest.json'), null as unknown as QaReport) ??
    (await runQA({ verbose: opts.verbose }))
  const screenshotReport: ScreenshotReport =
    readJSON(
      path.join(AI_DIR, 'reports', 'screenshots-latest.json'),
      null as unknown as ScreenshotReport
    ) ?? (await runScreenshots({ verbose: opts.verbose }))

  const images = collectScreenshotPairs(screenshotReport)

  const userPrompt = [
    '## REQUIREMENTS.md',
    requirements,
    '',
    previousReview
      ? '## Previous REVIEW.md (for context — do not reopen accepted subjective decisions without new evidence)'
      : '',
    previousReview ?? '',
    '',
    '## Git status',
    '```',
    tail(gitStatus(), 2000),
    '```',
    '',
    '## Git diff --stat',
    '```',
    tail(gitDiffStat(), 2000),
    '```',
    '',
    '## Git diff',
    '```diff',
    tail(gitDiff(), 8000),
    '```',
    '',
    '## Changed files',
    gitChangedFiles().join('\n') || '(none)',
    '',
    '## QA results',
    '```json',
    JSON.stringify(summarizeQaForReview(qaReport), null, 2),
    '```',
    '',
    '## Screenshot / console / network evidence',
    '```json',
    JSON.stringify(
      screenshotReport.routes.map((r) => ({
        name: r.name,
        url: r.url,
        consoleErrors: r.consoleErrors,
        failedRequests: r.failedRequests
      })),
      null,
      2
    ),
    '```',
    '',
    images.length > 0
      ? `${images.length} screenshot image(s) are attached below (current build, and reference where available).`
      : 'No screenshots available for this review.'
  ]
    .filter((l) => l !== '')
    .join('\n')

  if (opts.verbose) log(`calling OpenAI (${config.review.model})...`)
  const raw = await callOpenAI({
    model: config.review.model,
    system: reviewerPrompt,
    user: userPrompt,
    schema: REVIEW_SCHEMA,
    schemaName: 'review',
    images
  })
  const review = raw as ReviewResult

  // Deterministic safety net on top of the model's own judgement: never
  // let a P0/P1/P2 or a failing required QA check slip through as
  // "approved" just because the model said so.
  const counts = countByPriority(review.issues)
  const qaBlocking =
    (config.requireBuildSuccess &&
      qaReport.commands.some((c) => c.name === 'build' && !c.success)) ||
    (config.requireTestsSuccess && qaReport.commands.some((c) => c.name === 'test' && !c.success))
  const meetsBar =
    review.score >= config.approvalScore &&
    counts.P0 === 0 &&
    counts.P1 === 0 &&
    counts.P2 === 0 &&
    !qaBlocking

  const oscillation = detectOscillation(review.issues)
  if (oscillation.flagged) {
    review.status = 'human_review_required'
    review.human_review_required = true
    review.summary += `\n\nOscillation detected — stopping for human review:\n${oscillation.reasons.join('\n')}`
  } else if (review.status === 'approved' && !meetsBar) {
    review.status = 'changes_required'
  } else if (review.status !== 'approved' && meetsBar && counts.P3 === 0 && counts.P4 === 0) {
    review.status = 'approved'
  }
  if (qaBlocking && review.status === 'approved') review.status = 'changes_required'

  writeJSON(path.join(AI_DIR, 'REVIEW.json'), review)
  writeText(path.join(AI_DIR, 'REVIEW.md'), formatReviewMarkdown(review))

  if (opts.verbose) {
    log(`status: ${review.status}  score: ${review.score}`)
    log(`P0:${counts.P0} P1:${counts.P1} P2:${counts.P2} P3:${counts.P3} P4:${counts.P4}`)
  }

  return review
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  runReview({ verbose: true })
    .then((review) => {
      section('Review complete (review-only mode — no changes were made)')
      log(`See .ai/REVIEW.md / .ai/REVIEW.json for full detail.`)
      process.exit(review.status === 'blocked' ? 1 : 0)
    })
    .catch((err) => {
      console.error(`ai:review failed: ${(err as Error).message}`)
      process.exit(1)
    })
}
