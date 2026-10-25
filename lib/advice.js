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
import { join } from 'node:path';
/** The upstream report of this defect. */
export const DISCUSSION = '7635';
/** The settings file a profile asks pnpm for. */
export const WORKSPACE_FILE = 'pnpm-workspace.yaml';
/** The pnpm setting that decides whether peers are installed into the profile. */
export const AUTO_INSTALL_PEERS = 'autoInstallPeers';
/** The full path of a profile's pnpm settings. */
export function workspacePath(profileDir) {
    return join(profileDir, WORKSPACE_FILE);
}
/**
 * The advisory attached to the failing tool result.
 * @param failure - the recognized failure.
 * @param context - the boot scan, the repair outcome, and the config.
 * @returns the advisory body.
 */
export function adviceText(failure, context) {
    const report = context.report;
    const finding = report?.findings.find(entry => entry.name === failure.packageName);
    const lines = [
        'A child process could not start because a package installed into this profile cannot resolve a peer it',
        'declares. Retrying this call cannot help: the child exits before it runs anything, every time.',
        '',
        `  the child failed on: ${failure.packageName}`,
    ];
    if (failure.importer !== undefined)
        lines.push(`  imported from: ${failure.importer}`);
    if (finding !== undefined) {
        lines.push(`  required by: ${finding.requiredBy.join(', ')}${finding.range === undefined ? '' : ` (${finding.range})`}`);
        lines.push(`  what the walk found: ${describeProbe(finding.probe.candidates.map(entry => entry.evidence))}`);
    }
    if (report !== undefined) {
        lines.push(`  shared peer fallback: ${report.sharedModulesDir}`);
        if (report.autoInstallPeers !== undefined) {
            lines.push(`  profile sets ${AUTO_INSTALL_PEERS}: ${String(report.autoInstallPeers)} in ${workspacePath(report.profileDir)}`);
        }
    }
    else {
        lines.push('  the boot scan did not run in this process, so the branch above is named but not classified');
    }
    lines.push('', 'Why: through 0.1.6 `dsh` healed a shared peer fallback for profiles on every boot. From 0.1.7 the writer', 'is gone while the setting that made it necessary (`autoInstallPeers: false`) is unchanged, so peers that', 'only the installation owns are resolvable inside the launching process (it holds an in-memory resolution', 'table) and unresolvable in every child it spawns. `ctx.subprocess.spawn` starts a bare `node`, the runner', 'deletes every `NODE_*` / `TSX_*` variable before launch, and nothing else in the runner protocol carries a', 'resolution — which is why chat still works while `run_code` and voice input die.', '', 'Two ways out, both the user\'s to choose:', '');
    if (report !== undefined) {
        lines.push(`  1. Let pnpm install the peers into the profile: add \`${AUTO_INSTALL_PEERS}: true\` to`, `     ${workspacePath(report.profileDir)}, run \`pnpm install\` in ${report.profileDir}, then restart dsh.`, '     The plugin mounts are unaffected: the installation\'s names stay reserved for the launching process,', '     so it keeps using its own single `cordis`.', '');
        if (context.repairEnabled) {
            lines.push(`  2. Repair is already enabled in this mount. It links the installation's own copies into`, `     ${report.sharedModulesDir} — a directory 0.1.7 neither writes nor deletes. Restart dsh to apply it,`, '     and check the host log for what it did.', '');
        }
        else {
            lines.push(`  2. Mount this advisor with \`repair: true\` and restart: it links the installation's own copies into`, `     ${report.sharedModulesDir}, the directory 0.1.7 no longer writes. It only ever adds or refreshes`, '     links there, and it refreshes them on every boot so a later dsh upgrade cannot leave them dangling.', '');
        }
    }
    else {
        lines.push(`  1. Add \`${AUTO_INSTALL_PEERS}: true\` to this profile's ${WORKSPACE_FILE}, run \`pnpm install\` in the`, '     profile directory, then restart dsh.', '  2. Or mount this advisor with `repair: true` and restart, so the shared peer fallback is filled in again.', '');
    }
    lines.push('What does not help: retrying this call, setting `NODE_PATH` (the subprocess runner deletes it before', 'launch), and proxy or routing changes (this is not a network failure).', '', 'Stop retrying this tool and tell the user which option they want.');
    if (context.repairs.length > 0) {
        lines.push('', 'This process already repaired part of it at boot:', ...context.repairs.map(outcome => `  ${outcome.ok ? 'linked' : 'failed'}: ${outcome.action.name} -> ${outcome.action.target}${outcome.error === undefined ? '' : ` (${outcome.error})`}`));
    }
    if (context.href !== undefined && context.href.length > 0)
        lines.push('', context.href);
    return lines.join('\n');
}
/** The one-line transcript summary for a recognized failure. */
export function summaryOf(failure) {
    return `child process could not resolve the profile peer "${failure.packageName}"`;
}
/** The one-line host-side account of a recognized failure. */
export function hostLine(failure) {
    return `profile-fallback-advisor: a child process failed on "${failure.packageName}"`
        + `${failure.importer === undefined ? '' : ` imported from ${failure.importer}`} — the profile's shared peer`
        + ` fallback no longer serves the peers pnpm was asked not to install; advisory delivered to the model`
        + ` (discussion ${DISCUSSION})`;
}
/** The boot-time log block for one scan. */
export function bootReportLines(report) {
    const lines = [];
    if (report.findings.length === 0) {
        lines.push(`profile-fallback-advisor: ${String(report.required)} required name(s) resolve for a bare child process`
            + ` in ${report.profileDir}; nothing to report`);
        return lines;
    }
    lines.push(`profile-fallback-advisor: ${String(report.findings.length)} of ${String(report.required)} required`
        + ` name(s) are unresolvable by a bare child process in ${report.profileDir}; tool execution and voice input`
        + ` that spawn children will fail until the shared fallback is restored (discussion ${DISCUSSION})`);
    for (const finding of report.findings) {
        lines.push(`  - ${finding.name} (${finding.kind}, required by ${finding.requiredBy.join(', ') || 'nobody local'}):`
            + ` ${finding.probe.verdict} — ${describeProbe(finding.probe.candidates.map(entry => entry.evidence))}`);
    }
    for (const note of report.notes)
        lines.push(`  note: ${note}`);
    return lines;
}
/** Join candidate evidence into one compact phrase. */
function describeProbe(evidence) {
    return evidence.length === 0 ? 'no candidate directory was found' : evidence.join('; ');
}
