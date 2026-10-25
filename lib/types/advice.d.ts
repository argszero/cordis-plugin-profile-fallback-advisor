/**
 * The words. Pure functions over facts, so the wording is testable without a
 * context, a filesystem, or a tool pipeline.
 *
 * Two audiences, two registers:
 *
 * - the **model** gets an advisory that says what broke, why retrying cannot
 *   help, and which user-side choice to hand back — the same shape this plugin
 *   family uses for the sandbox failures;
 * - the **host log** gets one line per event, naming the same facts, so an
 *   operator reading stderr sees the diagnosis without a session.
 *
 * Every path in the text is quoted from the facts that were measured — the
 * profile directory, the shared fallback directory, the importer, the resolver's
 * answer — never from a template with a guess in it.
 *
 * @module @argszero/cordis-plugin-profile-fallback-advisor
 */
import type { ScanReport } from './scan.js';
import type { ChildModuleFailure } from './signature.js';
import type { RepairOutcome } from './repair.js';
/** The upstream report of this defect. */
export declare const DISCUSSION = "7635";
/** The settings file a profile asks pnpm for. */
export declare const WORKSPACE_FILE = "pnpm-workspace.yaml";
/** The pnpm setting that decides whether peers are installed into the profile. */
export declare const AUTO_INSTALL_PEERS = "autoInstallPeers";
/** What the advisory is allowed to say about the running profile. */
export interface AdviceContext {
    /** The scan taken at boot, when one could be taken. */
    report: ScanReport | undefined;
    /** The outcome of an opt-in repair, when one ran. */
    repairs: readonly RepairOutcome[];
    /** An optional thread URL to quote. */
    href: string | undefined;
    /** Whether this advisor is mounted in the repair configuration. */
    repairEnabled: boolean;
}
/** The full path of a profile's pnpm settings. */
export declare function workspacePath(profileDir: string): string;
/**
 * The advisory attached to the failing tool result.
 * @param failure - the recognized failure.
 * @param context - the boot scan, the repair outcome, and the config.
 * @returns the advisory body.
 */
export declare function adviceText(failure: ChildModuleFailure, context: AdviceContext): string;
/** The one-line transcript summary for a recognized failure. */
export declare function summaryOf(failure: ChildModuleFailure): string;
/** The one-line host-side account of a recognized failure. */
export declare function hostLine(failure: ChildModuleFailure): string;
/** The boot-time log block for one scan. */
export declare function bootReportLines(report: ScanReport): readonly string[];
