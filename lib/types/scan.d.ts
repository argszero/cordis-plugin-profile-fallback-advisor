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
/** Directory `dsh` uses for a profile's shared peer fallback, under the harness home. */
export declare const PROFILES_DIRNAME = "profiles";
/** The per-profile projection directory the 0.1.6 link backend wrote. */
export declare const MODULE_FALLBACK_DIR = ".dsh-module-fallback";
/** The manifest field that marks a directory as a `dsh`-managed module proxy. */
export declare const PROXY_MARKER = "moduleFallback";
/** How a required name is required. */
export type RequirementKind = 'peer' | 'dependency';
/** One loadable package the installation owns, as the resolver reports it. */
export interface InstallationCopy {
    /** Absolute package directory. */
    dir: string;
    /** Version when the manifest declares one. */
    version: string | undefined;
}
/** Resolves a package name to the copy the *installation* owns, when it has one. */
export type InstallationResolver = (name: string) => InstallationCopy | undefined;
/** What one candidate directory turned out to be. */
export type CandidateKind = 
/** Nothing is there — the walk continues. */
'absent'
/** A symlink whose target no longer exists — the walk continues. */
 | 'dangling'
/** Something is there but it is not loadable as a bare specifier. */
 | 'not-a-package'
/** A `dsh`-managed proxy whose re-export targets are all present. */
 | 'proxy'
/** A `dsh`-managed proxy carrying at least one dead re-export target. */
 | 'proxy-stale'
/** A loadable package directory. */
 | 'package';
/** One directory Node's upward walk visits, nearest first. */
export interface Candidate {
    /** The candidate path (`<dir>/<name>`). */
    path: string;
    /** What was found there. */
    kind: CandidateKind;
    /** The real path the candidate resolved to, for the kinds that resolve. */
    resolved: string | undefined;
    /** Declared version, when the candidate is a readable package. */
    version: string | undefined;
    /** For proxy kinds: the re-export targets, and which of them are missing. */
    targets: readonly string[];
    deadTargets: readonly string[];
    /** One line of evidence, for the report. */
    evidence: string;
}
/** The verdict for one required name, from a child's point of view. */
export type NameVerdict = 
/** The walk reaches a loadable package. */
'ok'
/** No candidate exists at any level the walk visits. */
 | 'missing'
/** Candidates exist but every one of them is a dangling symlink. */
 | 'dangling'
/** A candidate stats but is not loadable (no manifest, or unreadable). */
 | 'unresolved'
/** A `dsh`-managed proxy is found but its re-export targets are gone. */
 | 'stale-proxy';
/** One required name, probed along the child's walk. */
export interface NameProbe {
    /** Bare package name. */
    name: string;
    /** The verdict a child process would reach. */
    verdict: NameVerdict;
    /** Candidates, nearest first, up to and including the one that stopped the walk. */
    candidates: readonly Candidate[];
    /** The directory the walk stopped at, when it stopped at a readable entry. */
    loaded: string | undefined;
}
/** One required name that a child cannot resolve. */
export interface Finding {
    /** Bare package name. */
    name: string;
    /** How it is required. */
    kind: RequirementKind;
    /** Packages that declare it, in scan order. */
    requiredBy: readonly string[];
    /** The declared range, when the declarers agree on one. */
    range: string | undefined;
    /** The probe that produced the verdict. */
    probe: NameProbe;
    /**
     * The installation's own copy, when the injected resolver knows one. A finding
     * without it cannot be bridged by a link — the copy has to exist somewhere.
     */
    installation: InstallationCopy | undefined;
}
/** The `autoInstallPeers` setting a profile asks pnpm for, when it states one. */
export type AutoInstallPeers = boolean | undefined;
/** Everything one scan learned. */
export interface ScanReport {
    /** The profile the scan describes. */
    profileDir: string;
    /** The shared fallback directory (`<home>/profiles/node_modules`). */
    sharedModulesDir: string;
    /** `<home>/profiles`. */
    profilesDir: string;
    /** How many distinct names the profile's local packages require. */
    required: number;
    /** The names a child cannot resolve, sorted by name. */
    findings: readonly Finding[];
    /** The `autoInstallPeers` value the profile's `pnpm-workspace.yaml` states. */
    autoInstallPeers: AutoInstallPeers;
    /** Honest limits of this scan, for the report and the log. */
    notes: readonly string[];
}
/** Options for {@link scanProfileFallback}. */
export interface ScanOptions {
    /** The profile directory (`profileContext.dir`). */
    profileDir: string;
    /** The harness home (`profileContext.home`). */
    home: string;
    /** Resolves the installation's own copy of a name; omit to report without it. */
    installation?: InstallationResolver;
    /** Extra names to probe even when no local package declares them. */
    extraNames?: readonly string[];
}
/** Runtime dependencies of a manifest we care about. */
interface Declared {
    peer: Record<string, string>;
    dependency: Record<string, string>;
}
/**
 * Describe one candidate path the way the walk sees it.
 * @param path - the candidate path (`<modulesDir>/<name>`).
 * @returns the candidate observation.
 */
export declare function describeCandidate(path: string): Candidate;
/** One package installed into the profile's own `node_modules`. */
interface InstalledPackage {
    /** Bare package name. */
    name: string;
    /** Absolute package directory. */
    dir: string;
    /** What it declares. */
    declares: Declared;
}
/**
 * Enumerate the packages installed at the top level of a profile's `node_modules`.
 *
 * Symlinked entries (the hoisted linker's normal shape) are read through the
 * link; a dangling one is skipped, because it declares nothing.
 * @param profileDir - the profile directory.
 * @returns the readable packages, sorted by name.
 */
export declare function installedPackages(profileDir: string): readonly InstalledPackage[];
/**
 * Probe one name along the walk a child process performs.
 * @param name - the bare package name.
 * @param modulesDirs - candidate directories, nearest first.
 * @returns the verdict and the candidates the walk visited.
 */
export declare function probeName(name: string, modulesDirs: readonly string[]): NameProbe;
/**
 * Scan one profile for names a child process cannot resolve.
 * @param options - the profile, the home, and the optional installation resolver.
 * @returns the report; findings is empty when a child could resolve everything.
 */
export declare function scanProfileFallback(options: ScanOptions): ScanReport;
/**
 * Read the `autoInstallPeers` setting a profile asks pnpm for.
 *
 * Read as text on purpose: the file is a pnpm settings document whose shape
 * belongs to pnpm, and a YAML dependency would be a second parser to keep in
 * step with it for one boolean.
 * @param profileDir - the profile directory.
 * @returns the setting, or undefined when the file does not state one.
 */
export declare function readAutoInstallPeers(profileDir: string): AutoInstallPeers;
export {};
