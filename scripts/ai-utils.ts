// Shared helpers for the .ai/ development review loop (scripts/ai-*.ts).
//
// Everything project-specific lives in .ai/config.json + .ai/prompts/*.md,
// not here — this file is meant to be copyable into another project
// almost unchanged. It intentionally has zero dependencies beyond
// TypeScript + Node built-ins (no `dotenv`, no `openai` SDK) so adopting
// the framework elsewhere only costs `tsx` + `playwright` as new
// devDependencies.
//
// Safety note: every git helper below is READ-ONLY (status/diff/log).
// Nothing in this file — or anywhere else under scripts/ai-*.ts — may
// call a mutating git command (add/commit/push/reset/merge/checkout/
// clean). See .ai/README.md "Safety" section.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')
export const AI_DIR = path.join(ROOT, '.ai')
export const ENV_LOCAL_PATH = path.join(ROOT, '.env.local')

// ---------- logging ----------

export function log(message: string): void {
  console.log(message)
}

export function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ---------- env ----------

/** process.env first, then a manual (no-dependency) .env.local parse. */
export function loadEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name]!.trim()
  if (!existsSync(ENV_LOCAL_PATH)) return undefined
  const raw = readFileSync(ENV_LOCAL_PATH, 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`))
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** Recursively replaces "${VAR_NAME}" placeholders in config values. */
export function resolveEnvPlaceholders<T>(value: T): T {
  if (typeof value === 'string') {
    const m = value.match(/^\$\{([A-Z0-9_]+)\}$/)
    if (m) return (loadEnvVar(m[1]) ?? '') as unknown as T
    return value
  }
  if (Array.isArray(value)) return value.map(resolveEnvPlaceholders) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveEnvPlaceholders(v)
    }
    return out as T
  }
  return value
}

// ---------- fs / json ----------

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function readJSON<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch (err) {
    log(`warning: failed to parse ${path.relative(ROOT, filePath)}: ${(err as Error).message}`)
    return fallback
  }
}

export function writeJSON(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
}

export function readTextIfExists(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, content)
}

/** Truncates long command output before it's sent to the reviewer model. */
export function tail(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text
  return `…(truncated, showing last ${maxChars} chars)…\n` + text.slice(-maxChars)
}

// ---------- config ----------

export interface AiConfig {
  maxIterations: number
  approvalScore: number
  autoFixPriorities: string[]
  requireBuildSuccess: boolean
  requireTestsSuccess: boolean
  review: { provider: string; model: string }
  screenshots: {
    enabled: boolean
    viewport: { width: number; height: number }
    routes: Array<{ name: string; url: string; captureOffsetsMs?: number[] }>
    serveDir?: string
    settleMs?: number
  }
  claude: { command: string; args: string[] }
}

const DEFAULT_CONFIG: AiConfig = {
  maxIterations: 5,
  approvalScore: 90,
  autoFixPriorities: ['P0', 'P1', 'P2'],
  requireBuildSuccess: true,
  requireTestsSuccess: true,
  review: { provider: 'openai', model: '${OPENAI_MODEL}' },
  screenshots: {
    enabled: true,
    viewport: { width: 1920, height: 1080 },
    routes: [{ name: 'dashboard', url: '/' }],
    settleMs: 700
  },
  claude: { command: 'claude', args: ['-p'] }
}

// Used only when OPENAI_MODEL isn't set anywhere (env or .env.local) —
// config.json intentionally references "${OPENAI_MODEL}" rather than a
// hardcoded model string so upgrading is a one-line env change, not a
// code change. This is just the last-resort fallback.
const FALLBACK_OPENAI_MODEL = 'gpt-4o'

export function loadConfig(): AiConfig {
  const raw = readJSON<Partial<AiConfig>>(path.join(AI_DIR, 'config.json'), {})
  const merged: AiConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    review: { ...DEFAULT_CONFIG.review, ...raw.review },
    screenshots: { ...DEFAULT_CONFIG.screenshots, ...raw.screenshots },
    claude: { ...DEFAULT_CONFIG.claude, ...raw.claude }
  }
  const resolved = resolveEnvPlaceholders(merged)
  if (!resolved.review.model) resolved.review.model = FALLBACK_OPENAI_MODEL
  return resolved
}

// ---------- shell ----------

export interface CommandResult {
  name: string
  command: string
  args: string[]
  exitCode: number | null
  success: boolean
  durationMs: number
  stdout: string
  stderr: string
}

/** Runs a command without a shell, never throws — a non-zero exit is a normal result. */
export function runCommand(name: string, command: string, args: string[] = []): CommandResult {
  const start = Date.now()
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: false })
  const durationMs = Date.now() - start
  return {
    name,
    command,
    args,
    exitCode: result.status,
    success: result.status === 0 && !result.error,
    durationMs,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '') + (result.error ? `\n${result.error.message}` : '')
  }
}

export function commandExists(command: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8'
  })
  return probe.status === 0
}

// ---------- git (READ-ONLY — see file header) ----------

export function isGitRepo(): boolean {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  return r.status === 0
}

export function gitStatus(): string {
  return spawnSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''
}

export function gitDiff(): string {
  return spawnSync('git', ['diff'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''
}

export function gitDiffStat(): string {
  return spawnSync('git', ['diff', '--stat'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''
}

export function gitChangedFiles(): string[] {
  const out =
    spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[A-Z?!]+\s+/, ''))
}

// ---------- OpenAI (fetch-based, no SDK dependency) ----------

export interface OpenAiCallOptions {
  model: string
  system: string
  user: string
  /** JSON Schema the response must satisfy (Structured Outputs, strict mode). */
  schema: object
  schemaName?: string
  /** Optional base64 data: URI images to attach as vision input (e.g. screenshots). */
  images?: Array<{ label: string; dataUri: string }>
}

export async function callOpenAI(opts: OpenAiCallOptions): Promise<unknown> {
  const apiKey = loadEnvVar('OPENAI_API_KEY')
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY not set. Add it to .env.local (never committed) or export it in your shell.'
    )
  }

  // Sandboxed/locked-down environments route egress through a proxy that
  // Node's built-in fetch doesn't read from HTTP(S)_PROXY automatically —
  // same situation documented in scripts/fetch-tmdb-artwork.mjs. Only
  // engage it if the env var is actually set; a no-op everywhere else.
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
  let dispatcher: unknown
  if (proxyUrl) {
    try {
      const undici = await import('undici')
      dispatcher = new undici.ProxyAgent(proxyUrl)
    } catch {
      // undici isn't a direct dependency of this framework; if it's not
      // resolvable, fall through and let fetch attempt a direct request.
    }
  }

  const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: opts.user }]
  for (const img of opts.images ?? []) {
    userContent.push({ type: 'text', text: `Screenshot: ${img.label}` })
    userContent.push({ type: 'image_url', image_url: { url: img.dataUri } })
  }

  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: userContent }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: opts.schemaName ?? 'review', strict: true, schema: opts.schema }
    }
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    // @ts-expect-error undici-specific option, harmless when dispatcher is undefined
    dispatcher
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 800)}`)
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenAI response had no message content')
  return JSON.parse(content)
}

// ---------- priorities ----------

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const
export type Priority = (typeof PRIORITIES)[number]

export function countByPriority(issues: Array<{ priority: string }>): Record<string, number> {
  const counts: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 }
  for (const issue of issues) {
    if (issue.priority in counts) counts[issue.priority]++
  }
  return counts
}
