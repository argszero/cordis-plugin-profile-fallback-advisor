/**
 * The opt-in repair half: give the shared fallback the copies it stopped being
 * given.
 *
 * ## What it writes, and what it refuses to
 *
 * Exactly one directory is written: `<home>/profiles/node_modules` — the
 * cross-profile fallback that 0.1.7 leaves **unowned in both directions**. The
 * retired writer no longer creates entries there, and the surviving
 * `removeLinkProjections` never removes them either (it only unlinks
 * `<profile>/node_modules` entries that point into that profile's own
 * `.dsh-module-fallback`). So a link this plugin creates cannot be fought over
 * with the harness: nothing else is writing that directory.
 *
 * It refuses three things on purpose:
 *
 * - **Never touches the profile's own `node_modules`.** That tree belongs to
 *   pnpm; a dangling link there means the store generation was garbage
 *   collected, and the remedy is `pnpm install` in the profile — not a file
 *   written behind the package manager's back.
 * - **Never overwrites an entry it does not own.** A stale entry is replaced
 *   only when it is a dangling symlink (nothing is lost) or a directory that
 *   marks itself as a `dsh`-managed module proxy through its own manifest
 *   (`dsh.moduleFallback.targets`). Anything else — a file, a real directory, a
 *   foreign package — is reported as needing a human, never removed.
 * - **Never links a name the installation does not have.** A peer whose only
 *   copy is missing everywhere cannot be bridged by a link; it is reported.
 *
 * ## Why a temporary name and a rename
 *
 * Two `dsh` processes can boot at once. `symlink` + `rename` in the same
 * directory is atomic on every platform this plugin runs on, so a concurrent
 * boot sees either the old entry or the new one, never a half-created link.
 *
 * @module @argszero/cordis-plugin-profile-fallback-advisor
 */

import { mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describeCandidate, probeName } from './scan.js'
import type { Finding, NameVerdict, ScanReport } from './scan.js'

/** What a planned repair has to replace, if anything. */
export type Replacement = 'none' | 'dangling-link' | 'stale-proxy'

/** One link the repair intends to (re)create. */
export interface RepairAction {
  /** Bare package name. */
  name: string
  /** The link path under the shared fallback directory. */
  linkPath: string
  /** The directory the link should point at. */
  target: string
  /** What is being replaced. */
  replaces: Replacement
  /** Why this action was planned, for the log and the advisory. */
  reason: string
}

/** One finding the repair deliberately leaves alone. */
export interface SkippedFinding {
  /** Bare package name. */
  name: string
  /** Why it is left alone. */
  reason: string
}

/** The result of planning a repair. */
export interface RepairPlan {
  /** The actions to apply, in name order. */
  actions: readonly RepairAction[]
  /** The findings that will stay broken, each with its reason. */
  skipped: readonly SkippedFinding[]
}

/** One applied action's outcome. */
export interface RepairOutcome {
  /** The action that was applied. */
  action: RepairAction
  /** Whether the write reported success. */
  ok: boolean
  /** The failure, when it did not. */
  error: string | undefined
  /** The verdict a fresh probe reaches afterwards, when one could be taken. */
  verified: NameVerdict | undefined
}

/** Options for {@link applyRepairs}. */
export interface ApplyOptions {
  /** The directories a child's walk visits, for the post-write verification probe. */
  modulesDirs: readonly string[]
}

/**
 * Decide which broken names can be bridged by a link.
 * @param report - the scan report.
 * @returns the actions, plus the findings that stay broken.
 */
export function planRepairs(report: ScanReport): RepairPlan {
  const actions: RepairAction[] = []
  const skipped: SkippedFinding[] = []
  for (const finding of report.findings) {
    const decision = decide(finding, report)
    if (typeof decision === 'string') skipped.push({ name: finding.name, reason: decision })
    else actions.push(decision)
  }
  return { actions, skipped }
}

/** Decide one finding: a planned action, or the reason it stays broken. */
function decide(finding: Finding, report: ScanReport): RepairAction | string {
  const installation = finding.installation
  if (installation === undefined) {
    return 'the installation has no copy of this name, so a link would only point at nothing'
  }
  const linkPath = join(report.sharedModulesDir, finding.name)
  if (insideDirectory(installation.dir, report.sharedModulesDir)) {
    return `the resolved copy already lives in the shared fallback (${installation.dir})`
  }
  const existing = describeCandidate(linkPath)
  const replaces: Replacement | undefined = existing.kind === 'absent'
    ? 'none'
    : existing.kind === 'dangling'
      ? 'dangling-link'
      : existing.kind === 'proxy-stale'
        ? 'stale-proxy'
        : undefined
  if (replaces === undefined) {
    return existing.kind === 'package' || existing.kind === 'proxy'
      ? `a loadable copy already exists at ${linkPath}`
      : `an entry this plugin does not own exists at ${linkPath} (${existing.evidence}); remove it by hand`
  }
  return {
    name: finding.name,
    linkPath,
    target: installation.dir,
    replaces,
    reason: replaces === 'none'
      ? `absent from the shared fallback, which the child's walk visits`
      : `${replaces} left by an earlier generation, whose target no longer exists`,
  }
}

/** Whether `path` is `directory` itself or lies inside it. */
function insideDirectory(path: string, directory: string): boolean {
  const prefix = directory.endsWith('/') ? directory : `${directory}/`
  return path === directory || path.startsWith(prefix)
}

/**
 * Apply a repair plan.
 *
 * Every action is attempted; a failure is recorded and the rest continue, so one
 * unwritable name cannot cost the others.
 * @param actions - the plan's actions.
 * @param options - the walk directories, for verification.
 * @returns one outcome per action, in order.
 */
export function applyRepairs(actions: readonly RepairAction[], options: ApplyOptions): readonly RepairOutcome[] {
  return actions.map(action => applyOne(action, options))
}

/** Apply one action, then verify the result with a fresh probe. */
function applyOne(action: RepairAction, options: ApplyOptions): RepairOutcome {
  let ok = false
  let error: string | undefined
  try {
    mkdirSync(dirname(action.linkPath), { recursive: true })
    if (action.replaces === 'dangling-link') {
      // `rename` replaces a dangling link, but only where it can write the
      // directory entry; unlinking first keeps the Windows path honest, and a
      // concurrent boot re-creating it between the two steps is harmless (the
      // rename below wins either way).
      tryUnlink(action.linkPath)
    } else if (action.replaces === 'stale-proxy') {
      rmSync(action.linkPath, { recursive: true, force: true })
    }
    const temporary = `${action.linkPath}.${String(process.pid)}.${Math.random().toString(36).slice(2)}.tmp`
    symlinkSync(action.target, temporary, 'junction')
    renameSync(temporary, action.linkPath)
    ok = true
  } catch (failure: unknown) {
    error = failure instanceof Error ? failure.message : String(failure)
  }
  const verified = ok ? probeName(action.name, options.modulesDirs).verdict : undefined
  return { action, ok, error, verified }
}

/** Remove a link, tolerating a concurrent removal. */
function tryUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch (failure: unknown) {
    const code = (failure as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw failure
  }
}

/** One-line account of what a repair did, for the log and the advisory. */
export function describeOutcomes(outcomes: readonly RepairOutcome[]): readonly string[] {
  return outcomes.map(({ action, ok, error, verified }) => ok
    ? `linked ${action.name} -> ${action.target} (${action.reason}); verification after write: ${String(verified)}`
    : `failed to link ${action.name} -> ${action.target}: ${String(error)}`)
}
