/**
 * The reactive signature: a child process that died because a *profile-local*
 * package could not resolve its peer.
 *
 * ## What the failure looks like, and why it takes three facts to recognize
 *
 * The user-visible line is a wrapper the subprocess seam produces whenever a
 * child dies before it consumes the launch request — generic, and on its own it
 * means nothing more than "the child did not get that far":
 *
 *   Error: code run failed (worker-exit): subprocess scope exited before its
 *   bootstrap consumed the launch request
 *
 * Underneath it, the child's own stderr carries Node's module error:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis'
 *     imported from <profile>/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js
 *
 * Neither half is enough. The wrapper fires for *any* early child death (a
 * syntax error, a native-module mismatch, an OOM), and `ERR_MODULE_NOT_FOUND` on
 * its own is the most ordinary error in Node — it is what a typo produces. What
 * identifies *this* defect is the conjunction, plus where the importer sits:
 *
 * 1. the child never consumed its launch request (the wrapper, or the
 *    `worker-exit` marker the code runner adds);
 * 2. the missing specifier is a **package root**, not a relative path, not a
 *    subpath, not a `node:` builtin — a subpath miss is a different defect
 *    (the package is present, an export is not), and this plugin has nothing to
 *    say about it;
 * 3. the importer is a file inside a **profile's** `node_modules` — the tree
 *    whose peers the retired fallback used to serve. A miss anywhere else is
 *    somebody else's problem, and claiming it would make this plugin's advice
 *    wrong rather than merely broad.
 *
 * ## Which field is read
 *
 * The merged text (`error.message` first, then the rendered content), because
 * all three facts are structural: a bare package name in quotes next to Node's
 * `ERR_MODULE_NOT_FOUND` code, and an absolute path naming a profile's
 * `node_modules`. Unlike the bare sentence this plugin's sibling recognizes for
 * the persistent shell, nothing here can be produced by a command's own
 * stdout — a command that prints `ERR_MODULE_NOT_FOUND` would still have to
 * print a profile-shaped importer path to be classified, and if it did, the
 * diagnosis it would get happens to be the right one for that path.
 *
 * ## Which rendering is claimed, and what that costs
 *
 * The shape is Node's ESM sentence — `Cannot find package '<pkg>' imported from
 * <path>` — with the whitespace before `imported from` left as `\s+` because the
 * report pasted it wrapped. A CommonJS `Require stack:` block is a different
 * layout (its importer sits on its own line) and is **not** claimed: this plugin
 * does not claim a format it has not seen in the field. The cost is stated in the
 * README — a CJS-only package missing a peer keeps the bare error — and that is a
 * silence, not a false claim.
 *
 * @module @argszero/cordis-plugin-profile-fallback-advisor
 */
/** Phrases that mean "the child never consumed its launch request". */
export declare const CHILD_MARKERS: readonly ["subprocess scope exited before its bootstrap consumed the launch request", "worker-exit"];
/** The Node error code a missing package carries. */
export declare const MODULE_NOT_FOUND = "ERR_MODULE_NOT_FOUND";
/** One recognized child-process module failure. */
export interface ChildModuleFailure {
    /**
     * The discriminator this plugin keys on. It is one value today and is a named
     * type rather than a boolean so a second cause can be added without changing
     * every caller's meaning.
     */
    kind: 'profile-peer-missing';
    /** The bare package name the child could not find. */
    packageName: string;
    /** The importer path, when Node printed one. */
    importer: string | undefined;
    /** Whether the importer is known to be inside the running profile. */
    importerInProfile: boolean;
}
/** What the classifier knows about the running profile. */
export interface SignatureContext {
    /** The running profile's directory, when the launcher provided it. */
    profileDir?: string;
}
/**
 * Recognize the child-process profile-peer failure in one tool result's text.
 * @param text - the failure text to classify.
 * @param context - the running profile, when known.
 * @returns the recognized failure, or undefined when the text is not this one.
 */
export declare function classifyChildModuleFailure(text: string, context?: SignatureContext): ChildModuleFailure | undefined;
/**
 * The package root of a specifier, or undefined when it is not a bare package.
 * @param specifier - the specifier Node named.
 * @returns the package name, when the miss is a whole package.
 */
export declare function barePackageName(specifier: string): string | undefined;
