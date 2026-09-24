/**
 * The profile fallback scan: what a *child* process can resolve, and what it
 * cannot.
 *
 * ## Why the scan exists
 *
 * `dsh` gives out-of-tree plugins a flat, hoisted `node_modules` and asks pnpm
 * not to install peers (`autoInstallPeers: false` in the profile's
 * `pnpm-workspace.yaml`), because every plugin is supposed to share the
 * installation's single `cordis` instance instead of a duplicate. The missing
 * peers were served by a fallback directory that `dsh-app-boot` **maintained**
 * through 0.1.6 (`healProfilesModuleFallback` and friends) and **no longer
 * maintains** in 0.1.7: the writer was retired while the settings that created
 * the need stayed exactly as they were.
 *
 * Inside the launching process the loss is invisible, because that process
 * carries an in-memory resolution table (`createRuntimeResolution`) plus a
 * loader interception. A child process has neither: `ctx.subprocess.spawn`
 * starts a bare `node`, the runner deletes every `NODE_*`/`TSX_*` variable
 * (`subprocess-local/src/runner-launch.ts`), and nothing else in the runner
 * protocol carries a resolution (`runner-protocol.ts`). So the child resolves
 * the ordinary Node way — walk up `node_modules` — and dies on the first peer
 * that only the installation has.
 *
 * This module answers, for one profile, the question a child answers: **for
 * every name a locally installed package requires, where would a plain Node
 * process find it, and is what it finds loadable?**
 *
 * ## The walk it mirrors, and why it mirrors it
 *
 * Node's rule is *first candidate that stats, wins*: a dangling symlink fails
 * `stat` with `ENOENT`, so the walk **continues past it** to the next directory
 * up. That is why a stale link in `<profile>/node_modules` is often harmless
 * while the same link one level up is fatal — and why a per-entry "is this link
 * alive?" check would name the wrong culprit. The candidates are, nearest
 * first: `<profile>/node_modules`, then the shared `<home>/profiles/
 * node_modules`, then `<home>/node_modules`.
 *
 * A bare specifier under ESM also needs a manifest: a directory without a
 * `package.json` is not loadable (ESM has no `index.js` fallback), so such a
 * candidate is reported as unresolved rather than healthy.
 *
 * ## What is deliberately NOT claimed
 *
 * Only the top level of the profile's `node_modules` is inspected — the hoisted
 * linker's flattened shape, and the layer a child walks first. Transitive
 * layouts that a different linker could produce are outside this scan, and the
 * report says so (`ScanReport.notes`) rather than implying full coverage.
 *
 * @module @argszero/cordis-plugin-profile-fallback-advisor
 */

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Directory `dsh` uses for a profile's shared peer fallback, under the harness home. */
export const PROFILES_DIRNAME = 'profiles'

/** The per-profile projection directory the 0.1.6 link backend wrote. */
export const MODULE_FALLBACK_DIR = '.dsh-module-fallback'

/** The manifest field that marks a directory as a `dsh`-managed module proxy. */
export const PROXY_MARKER = 'moduleFallback'

/** How a required name is required. */
export type RequirementKind = 'peer' | 'dependency'

/** One loadable package the installation owns, as the resolver reports it. */
export interface InstallationCopy {
  /** Absolute package directory. */
  dir: string
  /** Version when the manifest declares one. */
  version: string | undefined
}

/** Resolves a package name to the copy the *installation* owns, when it has one. */
export type InstallationResolver = (name: string) => InstallationCopy | undefined

/** What one candidate directory turned out to be. */
export type CandidateKind =
  /** Nothing is there — the walk continues. */
  | 'absent'
  /** A symlink whose target no longer exists — the walk continues. */
  | 'dangling'
  /** Something is there but it is not loadable as a bare specifier. */
  | 'not-a-package'
  /** A `dsh`-managed proxy whose re-export targets are all present. */
  | 'proxy'
  /** A `dsh`-managed proxy carrying at least one dead re-export target. */
  | 'proxy-stale'
  /** A loadable package directory. */
  | 'package'

/** One directory Node's upward walk visits, nearest first. */
export interface Candidate {
  /** The candidate path (`<dir>/<name>`). */
  path: string
  /** What was found there. */
  kind: CandidateKind
  /** The real path the candidate resolved to, for the kinds that resolve. */
  resolved: string | undefined
  /** Declared version, when the candidate is a readable package. */
  version: string | undefined
  /** For proxy kinds: the re-export targets, and which of them are missing. */
  targets: readonly string[]
  deadTargets: readonly string[]
  /** One line of evidence, for the report. */
  evidence: string
}

/** The verdict for one required name, from a child's point of view. */
export type NameVerdict =
  /** The walk reaches a loadable package. */
  | 'ok'
  /** No candidate exists at any level the walk visits. */
  | 'missing'
  /** Candidates exist but every one of them is a dangling symlink. */
  | 'dangling'
  /** A candidate stats but is not loadable (no manifest, or unreadable). */
  | 'unresolved'
  /** A `dsh`-managed proxy is found but its re-export targets are gone. */
  | 'stale-proxy'

/** One required name, probed along the child's walk. */
export interface NameProbe {
  /** Bare package name. */
  name: string
  /** The verdict a child process would reach. */
  verdict: NameVerdict
  /** Candidates, nearest first, up to and including the one that stopped the walk. */
  candidates: readonly Candidate[]
  /** The directory the walk stopped at, when it stopped at a readable entry. */
  loaded: string | undefined
}

/** One required name that a child cannot resolve. */
export interface Finding {
  /** Bare package name. */
  name: string
  /** How it is required. */
  kind: RequirementKind
  /** Packages that declare it, in scan order. */
  requiredBy: readonly string[]
  /** The declared range, when the declarers agree on one. */
  range: string | undefined
  /** The probe that produced the verdict. */
  probe: NameProbe
  /**
   * The installation's own copy, when the injected resolver knows one. A finding
   * without it cannot be bridged by a link — the copy has to exist somewhere.
   */
  installation: InstallationCopy | undefined
}

/** The `autoInstallPeers` setting a profile asks pnpm for, when it states one. */
export type AutoInstallPeers = boolean | undefined

/** Everything one scan learned. */
export interface ScanReport {
  /** The profile the scan describes. */
  profileDir: string
  /** The shared fallback directory (`<home>/profiles/node_modules`). */
  sharedModulesDir: string
  /** `<home>/profiles`. */
  profilesDir: string
  /** How many distinct names the profile's local packages require. */
  required: number
  /** The names a child cannot resolve, sorted by name. */
  findings: readonly Finding[]
  /** The `autoInstallPeers` value the profile's `pnpm-workspace.yaml` states. */
  autoInstallPeers: AutoInstallPeers
  /** Honest limits of this scan, for the report and the log. */
  notes: readonly string[]
}

/** Options for {@link scanProfileFallback}. */
export interface ScanOptions {
  /** The profile directory (`profileContext.dir`). */
  profileDir: string
  /** The harness home (`profileContext.home`). */
  home: string
  /** Resolves the installation's own copy of a name; omit to report without it. */
  installation?: InstallationResolver
  /** Extra names to probe even when no local package declares them. */
  extraNames?: readonly string[]
}

/** Runtime dependencies of a manifest we care about. */
interface Declared {
  peer: Record<string, string>
  dependency: Record<string, string>
}

/**
 * Describe one candidate path the way the walk sees it.
 * @param path - the candidate path (`<modulesDir>/<name>`).
 * @returns the candidate observation.
 */
export function describeCandidate(path: string): Candidate {
  let linkStat
  try {
    linkStat = lstatSync(path)
  } catch {
    return candidate(path, 'absent', undefined, undefined, [], [], `absent: ${path}`)
  }
  let resolved = path
  if (linkStat.isSymbolicLink()) {
    try {
      resolved = realpathSync(path)
    } catch {
      return candidate(
        path, 'dangling', undefined, undefined, [], [],
        `dangling symlink: ${path} -> ${readLink(path)}`,
      )
    }
  }
  let isDirectory = false
  try {
    isDirectory = statSync(resolved).isDirectory()
  } catch {
    return candidate(path, 'dangling', resolved, undefined, [], [], `unreadable: ${path}`)
  }
  if (!isDirectory) {
    return candidate(path, 'not-a-package', resolved, undefined, [], [], `not a directory: ${path}`)
  }
  const manifest = readManifest(resolved)
  if (manifest === undefined) {
    return candidate(
      path, 'not-a-package', resolved, undefined, [], [],
      `no readable package.json: ${path} (ESM cannot load a bare specifier without a manifest)`,
    )
  }
  const version = typeof manifest.version === 'string' ? manifest.version : undefined
  const targets = proxyTargets(manifest)
  if (targets !== undefined) {
    const dead = targets.filter(target => !existsSync(target))
    return dead.length === 0
      ? candidate(path, 'proxy', resolved, version, targets, dead, `dsh module proxy: ${path} -> ${targets.join(', ')}`)
      : candidate(
        path, 'proxy-stale', resolved, version, targets, dead,
        `stale dsh module proxy: ${path} -> missing ${dead.join(', ')}`,
      )
  }
  return candidate(path, 'package', resolved, version, [], [], `package: ${path}${version === undefined ? '' : ` (v${version})`}`)
}

/** Assemble a candidate record. */
function candidate(
  path: string,
  kind: CandidateKind,
  resolved: string | undefined,
  version: string | undefined,
  targets: readonly string[],
  deadTargets: readonly string[],
  evidence: string,
): Candidate {
  return { path, kind, resolved, version, targets, deadTargets, evidence }
}

/** The re-export targets of a `dsh`-managed proxy manifest, when it is one. */
function proxyTargets(manifest: Record<string, unknown>): readonly string[] | undefined {
  const dsh = manifest.dsh
  if (dsh === null || typeof dsh !== 'object') return undefined
  const marker = (dsh as Record<string, unknown>)[PROXY_MARKER]
  if (marker === null || typeof marker !== 'object') return undefined
  const targets = (marker as Record<string, unknown>).targets
  if (targets === null || typeof targets !== 'object') return undefined
  const values = Object.values(targets as Record<string, unknown>)
  if (values.length === 0 || !values.every(value => typeof value === 'string')) return undefined
  return values as string[]
}

/** Read a package manifest, or undefined when it is absent or unparseable. */
function readManifest(dir: string): Record<string, unknown> | undefined {
  const path = join(dir, 'package.json')
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Read a symlink's raw target without following it.
 *
 * `readlinkSync`, not `readFileSync`: reading through the path follows the link
 * and fails with the very `ENOENT` that made the candidate dangling, which would
 * leave the evidence saying `?` exactly where the dead target belongs.
 * @param path - the symlink path.
 * @returns the raw target, or `?` when even that cannot be read.
 */
function readLink(path: string): string {
  try {
    return readlinkSync(path)
  } catch {
    return '?'
  }
}

/** One package installed into the profile's own `node_modules`. */
interface InstalledPackage {
  /** Bare package name. */
  name: string
  /** Absolute package directory. */
  dir: string
  /** What it declares. */
  declares: Declared
}

/** A manifest's `peerDependencies` and `dependencies`, both normalized. */
function declaredOf(manifest: Record<string, unknown>): Declared {
  return { peer: stringMap(manifest.peerDependencies), dependency: stringMap(manifest.dependencies) }
}

/** A string-valued record from a manifest field, ignoring everything else. */
function stringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

/**
 * Enumerate the packages installed at the top level of a profile's `node_modules`.
 *
 * Symlinked entries (the hoisted linker's normal shape) are read through the
 * link; a dangling one is skipped, because it declares nothing.
 * @param profileDir - the profile directory.
 * @returns the readable packages, sorted by name.
 */
export function installedPackages(profileDir: string): readonly InstalledPackage[] {
  const modules = join(profileDir, 'node_modules')
  const found: InstalledPackage[] = []
  for (const entry of readModules(modules)) {
    if (entry.name.startsWith('@')) {
      for (const scoped of readModules(join(modules, entry.name))) {
        push(join(modules, entry.name, scoped.name), `${entry.name}/${scoped.name}`)
      }
      continue
    }
    push(join(modules, entry.name), entry.name)
  }
  return found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  function push(dir: string, name: string): void {
    const manifest = readManifest(dir)
    if (manifest === undefined) return
    found.push({ name, dir, declares: declaredOf(manifest) })
  }
}

/** Read the entries of one `node_modules` directory, ignoring an absent one. */
function readModules(dir: string): readonly { name: string }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => ({ name: entry.name }))
  } catch {
    return []
  }
}

/**
 * Probe one name along the walk a child process performs.
 * @param name - the bare package name.
 * @param modulesDirs - candidate directories, nearest first.
 * @returns the verdict and the candidates the walk visited.
 */
export function probeName(name: string, modulesDirs: readonly string[]): NameProbe {
  const candidates: Candidate[] = []
  for (const modules of modulesDirs) {
    const found = describeCandidate(join(modules, name))
    candidates.push(found)
    if (found.kind === 'absent' || found.kind === 'dangling') continue
    // Node stops at the first entry that exists; whether what it stopped at is
    // loadable is the next question, and a stale proxy answers "not really".
    const verdict: NameVerdict = found.kind === 'package' || found.kind === 'proxy'
      ? 'ok'
      : found.kind === 'proxy-stale' ? 'stale-proxy' : 'unresolved'
    return { name, verdict, candidates, loaded: found.resolved ?? found.path }
  }
  const sawDangling = candidates.some(entry => entry.kind === 'dangling')
  return { name, verdict: sawDangling ? 'dangling' : 'missing', candidates, loaded: undefined }
}

/**
 * Scan one profile for names a child process cannot resolve.
 * @param options - the profile, the home, and the optional installation resolver.
 * @returns the report; findings is empty when a child could resolve everything.
 */
export function scanProfileFallback(options: ScanOptions): ScanReport {
  const profilesDir = join(options.home, PROFILES_DIRNAME)
  const sharedModulesDir = join(profilesDir, 'node_modules')
  const modulesDirs = [join(options.profileDir, 'node_modules'), sharedModulesDir, join(options.home, 'node_modules')]
  const notes: string[] = []
  const requirements = new Map<string, { kind: RequirementKind; requiredBy: Set<string>; ranges: Set<string> }>()

  const packages = installedPackages(options.profileDir)
  if (packages.length === 0) {
    notes.push(`no readable package is installed under ${join(options.profileDir, 'node_modules')}`)
  }
  for (const installed of packages) {
    for (const [kind, declared] of [['peer', installed.declares.peer], ['dependency', installed.declares.dependency]] as const) {
      for (const [name, range] of Object.entries(declared)) {
        const existing = requirements.get(name)
        const record = existing ?? { kind, requiredBy: new Set<string>(), ranges: new Set<string>() }
        // A name declared as both is reported as a peer: that is the axis whose
        // remedy this plugin carries, and pnpm treats the stricter axis first.
        if (existing === undefined || kind === 'peer') record.kind = kind
        record.requiredBy.add(installed.name)
        record.ranges.add(range)
        requirements.set(name, record)
      }
    }
  }
  for (const name of options.extraNames ?? []) {
    const existing = requirements.get(name)
    if (existing === undefined) requirements.set(name, { kind: 'peer', requiredBy: new Set(), ranges: new Set() })
  }

  const findings: Finding[] = []
  const names = [...requirements.keys()].sort()
  for (const name of names) {
    const requirement = requirements.get(name)
    if (requirement === undefined) continue
    const probe = probeName(name, modulesDirs)
    if (probe.verdict === 'ok') continue
    findings.push({
      name,
      kind: requirement.kind,
      requiredBy: [...requirement.requiredBy].sort(),
      range: requirement.ranges.size === 1 ? [...requirement.ranges][0] : undefined,
      probe,
      installation: options.installation?.(name),
    })
  }

  notes.push('only the top level of the profile node_modules is inspected (the hoisted linker shape)')
  if (options.installation === undefined) {
    notes.push('no installation resolver was available, so bridgeable names cannot be identified')
  }
  return {
    profileDir: options.profileDir,
    sharedModulesDir,
    profilesDir,
    required: names.length,
    findings,
    autoInstallPeers: readAutoInstallPeers(options.profileDir),
    notes,
  }
}

/**
 * Read the `autoInstallPeers` setting a profile asks pnpm for.
 *
 * Read as text on purpose: the file is a pnpm settings document whose shape
 * belongs to pnpm, and a YAML dependency would be a second parser to keep in
 * step with it for one boolean.
 * @param profileDir - the profile directory.
 * @returns the setting, or undefined when the file does not state one.
 */
export function readAutoInstallPeers(profileDir: string): AutoInstallPeers {
  let text: string
  try {
    text = readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
  } catch {
    return undefined
  }
  const match = /^\s*autoInstallPeers\s*:\s*(true|false)\s*$/mu.exec(text)
  if (match?.[1] === undefined) return undefined
  return match[1] === 'true'
}
