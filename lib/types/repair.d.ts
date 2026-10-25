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
import type { NameVerdict, ScanReport } from './scan.js';
/** What a planned repair has to replace, if anything. */
export type Replacement = 'none' | 'dangling-link' | 'stale-proxy';
/** One link the repair intends to (re)create. */
export interface RepairAction {
    /** Bare package name. */
    name: string;
    /** The link path under the shared fallback directory. */
    linkPath: string;
    /** The directory the link should point at. */
    target: string;
    /** What is being replaced. */
    replaces: Replacement;
    /** Why this action was planned, for the log and the advisory. */
    reason: string;
}
/** One finding the repair deliberately leaves alone. */
export interface SkippedFinding {
    /** Bare package name. */
    name: string;
    /** Why it is left alone. */
    reason: string;
}
/** The result of planning a repair. */
export interface RepairPlan {
    /** The actions to apply, in name order. */
    actions: readonly RepairAction[];
    /** The findings that will stay broken, each with its reason. */
    skipped: readonly SkippedFinding[];
}
/** One applied action's outcome. */
export interface RepairOutcome {
    /** The action that was applied. */
    action: RepairAction;
    /** Whether the write reported success. */
    ok: boolean;
    /** The failure, when it did not. */
    error: string | undefined;
    /** The verdict a fresh probe reaches afterwards, when one could be taken. */
    verified: NameVerdict | undefined;
}
/** Options for {@link applyRepairs}. */
export interface ApplyOptions {
    /** The directories a child's walk visits, for the post-write verification probe. */
    modulesDirs: readonly string[];
}
/**
 * Decide which broken names can be bridged by a link.
 * @param report - the scan report.
 * @returns the actions, plus the findings that stay broken.
 */
export declare function planRepairs(report: ScanReport): RepairPlan;
/**
 * Apply a repair plan.
 *
 * Every action is attempted; a failure is recorded and the rest continue, so one
 * unwritable name cannot cost the others.
 * @param actions - the plan's actions.
 * @param options - the walk directories, for verification.
 * @returns one outcome per action, in order.
 */
export declare function applyRepairs(actions: readonly RepairAction[], options: ApplyOptions): readonly RepairOutcome[];
/** One-line account of what a repair did, for the log and the advisory. */
export declare function describeOutcomes(outcomes: readonly RepairOutcome[]): readonly string[];
