// Reusable QA runner: auto-detects which checks a project actually
// supports (rather than assuming every project has lint/test/build) and
// runs them, capturing command + exit status + stdout/stderr + duration
// for each. Usable standalone (`npm run ai:qa`) or imported by
// scripts/ai-loop.ts.
//
// Detection is intentionally simple: read package.json scripts for a
// Node project, or look for pytest/ruff/mypy config for a Python one.
// Extend detectStack()/buildCommandList() for other stacks — the rest of
// the framework only depends on the QaReport shape below, not on how it
// was produced.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AI_DIR, ROOT, log, runCommand, section, tail, writeJSON, type CommandResult } from './ai-utils.js'

export interface QaReport {
  stack: string
  commands: CommandResult[]
  overallSuccess: boolean
  generatedAt: string
}

interface PlannedCommand {
  name: string
  command: string
  args: string[]
}

function detectNodeCommands(): PlannedCommand[] {
  const pkgPath = path.join(ROOT, 'package.json')
  if (!existsSync(pkgPath)) return []
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
  const scripts = pkg.scripts ?? {}
  const planned: PlannedCommand[] = []
  // Order matters: fail fast on cheap checks before the expensive build.
  if (scripts.lint) planned.push({ name: 'lint', command: 'npm', args: ['run', 'lint'] })
  if (scripts.typecheck) planned.push({ name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] })
  if (scripts.test) planned.push({ name: 'test', command: 'npm', args: ['run', 'test'] })
  if (scripts.build) planned.push({ name: 'build', command: 'npm', args: ['run', 'build'] })
  return planned
}

function detectPythonCommands(): PlannedCommand[] {
  const planned: PlannedCommand[] = []
  if (existsSync(path.join(ROOT, 'pyproject.toml')) || existsSync(path.join(ROOT, 'setup.cfg'))) {
    if (existsSync(path.join(ROOT, 'ruff.toml')) || existsSync(path.join(ROOT, '.ruff.toml'))) {
      planned.push({ name: 'lint', command: 'ruff', args: ['check', '.'] })
    }
    if (existsSync(path.join(ROOT, 'mypy.ini')) || existsSync(path.join(ROOT, '.mypy.ini'))) {
      planned.push({ name: 'typecheck', command: 'mypy', args: ['.'] })
    }
    planned.push({ name: 'test', command: 'pytest', args: [] })
  }
  return planned
}

function detectStackAndCommands(): { stack: string; commands: PlannedCommand[] } {
  const node = detectNodeCommands()
  if (node.length > 0) return { stack: 'node', commands: node }
  const py = detectPythonCommands()
  if (py.length > 0) return { stack: 'python', commands: py }
  return { stack: 'unknown', commands: [] }
}

export async function runQA(opts: { verbose?: boolean } = {}): Promise<QaReport> {
  const { stack, commands } = detectStackAndCommands()
  if (opts.verbose) section(`QA (${stack})`)
  if (commands.length === 0) {
    if (opts.verbose) log('No recognized QA commands found for this project.')
  }

  const results: CommandResult[] = []
  for (const c of commands) {
    if (opts.verbose) log(`running: ${c.command} ${c.args.join(' ')}`)
    const result = runCommand(c.name, c.command, c.args)
    if (opts.verbose) log(`  -> ${result.success ? 'PASS' : 'FAIL'} (${result.durationMs}ms)`)
    results.push(result)
  }

  const report: QaReport = {
    stack,
    commands: results,
    overallSuccess: results.every((r) => r.success),
    generatedAt: new Date().toISOString()
  }

  writeJSON(path.join(AI_DIR, 'reports', 'qa-latest.json'), report)
  writeJSON(path.join(AI_DIR, 'reports', `qa-${Date.now()}.json`), report)

  return report
}

/** Trims stdout/stderr for anything handed to the reviewer model — full output stays in the report file. */
export function summarizeQaForReview(report: QaReport): unknown {
  return {
    stack: report.stack,
    overallSuccess: report.overallSuccess,
    commands: report.commands.map((c) => ({
      name: c.name,
      success: c.success,
      exitCode: c.exitCode,
      durationMs: c.durationMs,
      stdoutTail: tail(c.stdout, 2000),
      stderrTail: tail(c.stderr, 2000)
    }))
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  runQA({ verbose: true }).then((report) => {
    section('QA summary')
    for (const c of report.commands) {
      log(`${c.success ? 'PASS' : 'FAIL'}  ${c.name}  (${c.durationMs}ms)`)
    }
    log(report.overallSuccess ? '\nAll QA checks passed.' : '\nSome QA checks failed — see .ai/reports/qa-latest.json')
    process.exit(report.overallSuccess ? 0 : 1)
  })
}
