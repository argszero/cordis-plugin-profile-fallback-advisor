/**
 * `profile-fallback-advisor`: turn "every child process this profile spawns dies
 * on a missing peer" into a diagnosis with two user-side ways out.
 *
 * ## The defect
 *
 * `dsh` installs out-of-tree plugins into a profile's own `node_modules` and asks
 * pnpm not to install peers (`autoInstallPeers: false`), because every plugin is
 * meant to share the installation's single `cordis` instead of carrying a
 * duplicate. Through **0.1.6** the missing peers were served by a fallback
 * directory the boot package *maintained* on every start
 * (`healProfilesModuleFallback` and friends). From **0.1.7-rc.1** the writer is
 * gone — the boot package now computes a runtime resolution and writes no
 * module-resolution files at all — while the setting that created the need is
 * unchanged. Report `#7635` is the field result.
 *
 * The loss is invisible from inside the launching process: `installRuntimeInterception`
 * serves this process's loader and `registerWorkerResolution` serves worker
 * threads. **Subprocesses get neither.** `ctx.subprocess.spawn` starts a bare
 * `node`; the runner deletes every `NODE_*`/`TSX_*` variable before launch
 * (`subprocess-local/src/runner-launch.ts`) and the private runner protocol
 * carries only `cwd`/`env`/`control` — no resolution field. So a child resolves
 * the ordinary Node way, walks up `node_modules`, and dies on the first peer only
 * the installation has. Chat keeps working; `run_code` and voice input do not:
 *
 *   Error: code run failed (worker-exit): subprocess scope exited before its
 *   bootstrap consumed the launch request
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis'
 *     imported from <profile>/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js
 *
 * ## What it does
 *
 * 1. **A boot scan.** The same upward walk a child performs, run for every name
 *    the profile's locally installed packages require, against the profile's
 *    `node_modules`, the shared `<home>/profiles/node_modules`, and
 *    `<home>/node_modules`. The verdicts and the limits of the scan go to the
 *    host log either way — a quiet start and a scan that never ran must not look
 *    alike.
 * 2. **One advisory per agent.** On the first recognized child-process failure
 *    the failing tool result is enriched with a durable user-role message naming
 *    the package, the importer, what the walk found, and the two options the user
 *    owns: let pnpm install the peers, or mount this plugin with `repair: true`.
 *    The advisory rides `additionalContexts`, so the model reads it beside the
 *    failure instead of only in a log it never sees.
 * 3. **An opt-in repair** (`repair: true`, default off). It links the
 *    installation's own copies into the shared fallback directory —
 *    `<home>/profiles/node_modules`, which 0.1.7 neither writes nor deletes, so
 *    nothing else is writing there. It is **additive**: it creates and refreshes
 *    links, and the only entries it ever replaces are a dangling symlink or a
 *    directory that marks itself as a `dsh`-managed proxy. It never touches the
 *    profile's own `node_modules` (pnpm owns that tree) and never removes an entry
 *    it does not recognize.
 *
 * ## Where it acts, and why there
 *
 * One listener on the public `tools/post-execute` waterfall
 * (`@deepseek-ai/dsh-tools`): it sees the failure text the subprocess seam
 * propagates, an agent identity to attribute it to (`exec.agent`), and a channel
 * that speaks to the model in the same step (`PostToolDecision`'s
 * `additionalContexts`). The boot scan and the repair are ordinary filesystem
 * work with no seam of their own.
 *
 * ## What it deliberately does not do
 *
 * - **It does not make a child resolve anything by environment.** Every candidate
 *   carrier was checked and closed: the runner deletes `NODE_*`/`TSX_*`, and the
 *   runner protocol has no resolution field. The shared directory is the only
 *   cross-process carrier a third-party plugin can write.
 * - **It does not replace the subprocess service.** A contract-compatible
 *   subclass could inject a carrier, but a context admits one implementation per
 *   service — mounting it would displace the sandboxed local provider.
 * - **It never guesses a name.** A peer whose copy exists nowhere cannot be
 *   linked, so it is reported rather than approximated.
 * - **The real fix is upstream**: restore the writer, or tell the child about the
 *   resolution. This plugin is the stopgap.
 *
 * @module @argszero/cordis-plugin-profile-fallback-advisor
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { adviceText, bootReportLines, hostLine, summaryOf } from './advice.js'
import type { AdviceContext } from './advice.js'
import { applyRepairs, describeOutcomes, planRepairs } from './repair.js'
import type { RepairOutcome } from './repair.js'
import { scanProfileFallback } from './scan.js'
import type { InstallationCopy, InstallationResolver, ScanReport } from './scan.js'
import { classifyChildModuleFailure } from './signature.js'
import type { ChildModuleFailure } from './signature.js'
import { createAdviceLedger } from './state.js'

export const name = 'profile-fallback-advisor'

/** The tool pipeline this plugin observes. */
export const inject = ['tools']

/**
 * The producer kind every message this plugin writes carries.
 *
 * Its own kind rather than the retired `plugin` wrapper: the current session
 * format admits only a producer-owned kind — a message whose `source.kind` is the
 * string `plugin` is refused on the way in
 * (`packages/session/session-format-v3-to-v4/src/message-sources.ts`) — and the
 * source union is documented as merge-extensible, one kind per producer.
 */
export const SOURCE_KIND = 'profile-fallback-advisor'

/** The service name the launcher provides; read optionally, never required. */
export const PROFILE_CONTEXT = 'profileContext'

/** The profile facts this plugin reads, structurally. */
export interface ProfileFacts {
  /** The running profile's directory. */
  readonly dir: string
  /** The harness home (`$DSH_HOME`). */
  readonly home: string
  /** The installation's package.json, the anchor its own resolution starts from. */
  readonly installAnchor: string
}

/** Configures the scan and the opt-in repair. */
export interface Config {
  /**
   * Whether to link the installation's copies into the shared fallback directory
   * at boot. Off by default: the advisory is the contribution, and a plugin that
   * writes into the harness's own tree should have to be asked.
   */
  repair?: boolean
  /** Extra names to probe even when no locally installed package declares them. */
  extraNames?: string[]
  /** Tool-name wildcard patterns to watch; empty means every tool. */
  include?: string[]
  /** Tool-name wildcard patterns never watched. */
  exclude?: string[]
  /** URL quoted in the advisory as the upstream thread; optional. */
  href?: string
}

/** Compile one `*`-wildcard pattern to an anchored RegExp; all else is literal. */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Read the launcher's profile facts, when this process was launched by `dsh`.
 *
 * `get` is optional lookup (it reads the isolate's service store rather than the
 * ancestry walk), and this plugin deliberately does not declare the service: a
 * composition that mounts no launcher still gets the whole reactive half. The cast
 * exists because the *declaration* of `profileContext` lives in
 * `@deepseek-ai/dsh-app-boot` — a package this plugin does not depend on — so the
 * key is absent from the installed `Context` interface. The value is never read
 * through a property access, which is the failure mode that shape is known to
 * cause.
 * @param ctx - the plugin's context.
 * @returns the facts, or undefined when they are absent or malformed.
 */
export function readProfileFacts(ctx: Context): ProfileFacts | undefined {
  const lookup = ctx as unknown as { get(service: string, strict?: boolean): unknown }
  const found = lookup.get(PROFILE_CONTEXT)
  if (found === null || typeof found !== 'object') return undefined
  const candidate = found as Partial<Record<keyof ProfileFacts, unknown>>
  const { dir, home, installAnchor } = candidate
  if (typeof dir !== 'string' || typeof home !== 'string' || typeof installAnchor !== 'string') return undefined
  return { dir, home, installAnchor }
}

/**
 * Resolve a name to the copy the **installation** owns.
 *
 * The walk is Node's own for a bare specifier starting at the installation's
 * anchor: `node_modules/<name>` in that directory, then in each parent. No
 * `exports` map is consulted — the question is where the copy lives, not what its
 * entry point is — and the manifest must declare the name being looked for, so a
 * directory that merely shares the path cannot be mistaken for it.
 * @param anchor - an absolute path inside the installation (`ProfileFacts.installAnchor`).
 * @returns the resolver.
 */
export function createInstallationResolver(anchor: string): InstallationResolver {
  return (requested: string): InstallationCopy | undefined => {
    let directory = dirname(anchor)
    for (;;) {
      const candidate = join(directory, 'node_modules', requested)
      const manifest = readManifest(candidate)
      if (manifest?.name === requested) {
        const version = manifest.version
        return { dir: candidate, version: typeof version === 'string' ? version : undefined }
      }
      const parent = dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
  }
}

/** Read a package manifest, or undefined when it is absent or unparseable. */
function readManifest(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * The plain text of a failed result, from the authoritative field first.
 *
 * `error.message` is what the producing layer recorded and survives content
 * rewriting by other post-execute listeners; the rendered text is the fallback,
 * so a result whose content was replaced (spill policies, hooks) is still
 * classified from its message. Both halves are read here because this family's
 * three facts are structural — a child-exit marker, Node's error code, and an
 * absolute importer path naming a profile — rather than a quoted sentence.
 * @param result - the failed tool result.
 * @returns the text to classify.
 */
function failureText(result: Extract<ToolExecutionResult, { isError: true }>): string {
  const rendered = result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return result.error.message.length > 0 ? `${result.error.message}\n${rendered}` : rendered
}

/**
 * Wrap one notice as a user-role message.
 * @param text - the notice body.
 * @param summary - one-line account for the transcript row.
 * @returns the message, identified and frozen by the harness factory.
 */
function notice(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(summary),
    } as unknown as UserMessage['source'],
  })
}

/** Keep this plugin's notices ahead of any other context on the same result. */
function prepend(ours: UserMessage, theirs: readonly UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/** What the boot half learned, for the reactive half to quote. */
interface BootFacts {
  report: ScanReport | undefined
  repairs: readonly RepairOutcome[]
}

/**
 * Install the advisor.
 * @param ctx - context carrying the tool pipeline.
 * @param config - resolved options.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const repairEnabled = config.repair === true
  const extraNames = config.extraNames ?? []
  const includePatterns = (config.include ?? []).map(wildcardToRegExp)
  const excludePatterns = (config.exclude ?? []).map(wildcardToRegExp)
  const href = config.href
  const ledger = createAdviceLedger()
  const facts = boot(ctx, repairEnabled, extraNames)

  /** Whether a tool participates; untracked calls are transparent. */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /**
   * Read one settled call and decide whether it is the failure the model needs
   * told about.
   * @param exec - the call that just ran.
   * @param result - its settled outcome.
   * @returns the notice to attach, or undefined.
   */
  function inspect(exec: ToolExecution, result: ToolExecutionResult): UserMessage | undefined {
    const agent = exec.agent
    if (agent === undefined || !tracked(exec.name)) return undefined
    if (result.isError !== true) return undefined
    const failure = classifyChildModuleFailure(
      failureText(result),
      facts.report === undefined ? {} : { profileDir: facts.report.profileDir },
    )
    if (failure === undefined) return undefined
    if (!ledger.claim(agent)) return undefined
    ctx.logger.warn(hostLine(failure))
    return notice(adviceText(failure, context()), summaryOf(failure))
  }

  /** The advisory context: what the boot half learned, plus the mount's mode. */
  function context(): AdviceContext {
    return { report: facts.report, repairs: facts.repairs, repairEnabled, href }
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    let message: UserMessage | undefined
    try {
      message = inspect(exec, result)
    } catch (error: unknown) {
      // A broken advisor must not become a broken tool call.
      ctx.logger.warn(`profile-fallback-advisor: result left alone after internal error: ${String(error)}`)
    }
    const downstream = await next()
    if (message === undefined) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: prepend(message, downstream.additionalContexts),
      }
    }
    return { ...downstream, additionalContexts: prepend(message, downstream.additionalContexts) }
  })
}

/**
 * The boot half: scan, report, and — only when asked — repair.
 *
 * Every failure here is caught and logged: a plugin that cannot read the profile
 * must not stop the process that is loading it, and the reactive half needs no
 * scan at all.
 * @param ctx - the plugin's context, for logging.
 * @param repairEnabled - whether the operator asked for the repair.
 * @param extraNames - names to probe in addition to the declared ones.
 * @returns what the scan and the repair learned.
 */
function boot(ctx: Context, repairEnabled: boolean, extraNames: readonly string[]): BootFacts {
  const empty: BootFacts = { report: undefined, repairs: [] }
  let facts: ProfileFacts | undefined
  try {
    facts = readProfileFacts(ctx)
  } catch (error: unknown) {
    ctx.logger.warn(`profile-fallback-advisor: profile lookup failed, advisory only: ${String(error)}`)
    return empty
  }
  if (facts === undefined) {
    // Not a claim that everything is fine: without the launcher's facts there is
    // no profile to scan, and saying so is the difference between "nothing to
    // report" and "no report was taken".
    ctx.logger.warn('profile-fallback-advisor: no profileContext in this process, so no boot scan was taken; '
      + 'the reactive half still classifies child-process peer failures')
    return empty
  }
  try {
    const report = scanProfileFallback({
      profileDir: facts.dir,
      home: facts.home,
      installation: createInstallationResolver(facts.installAnchor),
      extraNames,
    })
    for (const line of bootReportLines(report)) {
      if (report.findings.length === 0) ctx.logger.info(line)
      else ctx.logger.warn(line)
    }
    if (!repairEnabled || report.findings.length === 0) return { report, repairs: [] }
    const plan = planRepairs(report)
    const repairs = applyRepairs(plan.actions, {
      modulesDirs: [join(facts.dir, 'node_modules'), report.sharedModulesDir, join(facts.home, 'node_modules')],
    })
    for (const line of describeOutcomes(repairs)) ctx.logger.warn(`profile-fallback-advisor: ${line}`)
    for (const skipped of plan.skipped) {
      ctx.logger.warn(`profile-fallback-advisor: left "${skipped.name}" alone — ${skipped.reason}`)
    }
    return { report, repairs }
  } catch (error: unknown) {
    ctx.logger.warn(`profile-fallback-advisor: scan or repair failed, advisory only: ${String(error)}`)
    return empty
  }
}
