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
import type { Context } from '@deepseek-ai/cordis';
import type { InstallationResolver } from './scan.js';
export declare const name = "profile-fallback-advisor";
/** The tool pipeline this plugin observes. */
export declare const inject: string[];
/**
 * The producer kind every message this plugin writes carries.
 *
 * Its own kind rather than the retired `plugin` wrapper: the current session
 * format admits only a producer-owned kind — a message whose `source.kind` is the
 * string `plugin` is refused on the way in
 * (`packages/session/session-format-v3-to-v4/src/message-sources.ts`) — and the
 * source union is documented as merge-extensible, one kind per producer.
 */
export declare const SOURCE_KIND = "profile-fallback-advisor";
/** The service name the launcher provides; read optionally, never required. */
export declare const PROFILE_CONTEXT = "profileContext";
/** The profile facts this plugin reads, structurally. */
export interface ProfileFacts {
    /** The running profile's directory. */
    readonly dir: string;
    /** The harness home (`$DSH_HOME`). */
    readonly home: string;
    /** The installation's package.json, the anchor its own resolution starts from. */
    readonly installAnchor: string;
}
/** Configures the scan and the opt-in repair. */
export interface Config {
    /**
     * Whether to link the installation's copies into the shared fallback directory
     * at boot. Off by default: the advisory is the contribution, and a plugin that
     * writes into the harness's own tree should have to be asked.
     */
    repair?: boolean;
    /** Extra names to probe even when no locally installed package declares them. */
    extraNames?: string[];
    /** Tool-name wildcard patterns to watch; empty means every tool. */
    include?: string[];
    /** Tool-name wildcard patterns never watched. */
    exclude?: string[];
    /** URL quoted in the advisory as the upstream thread; optional. */
    href?: string;
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
export declare function readProfileFacts(ctx: Context): ProfileFacts | undefined;
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
export declare function createInstallationResolver(anchor: string): InstallationResolver;
/**
 * Install the advisor.
 * @param ctx - context carrying the tool pipeline.
 * @param config - resolved options.
 */
export declare function apply(ctx: Context, config?: Config): void;
