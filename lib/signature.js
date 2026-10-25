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
export const CHILD_MARKERS = [
    'subprocess scope exited before its bootstrap consumed the launch request',
    'worker-exit',
];
/** The Node error code a missing package carries. */
export const MODULE_NOT_FOUND = 'ERR_MODULE_NOT_FOUND';
/**
 * `Cannot find package '<specifier>' imported from <importer>`, or its module twin.
 *
 * The whitespace before `imported from` is `\s+`, not a single space: Node
 * prints the pair on one line, but every carrier this plugin reads from —
 * terminal width, a reporter's paste, a tool result's own wrapper — may put a
 * newline between them, and a classifier that only reads unwrapped text would
 * miss the exact report this plugin exists for.
 */
const NOT_FOUND = /Cannot find (?:package|module) '([^'\n]+)'\s+imported from ([^\s'"]+)|Cannot find (?:package|module) '([^'\n]+)'/gu;
/** A profile's `node_modules` as it appears in a stack or an importer path. */
const PROFILE_MODULES_SHAPE = /(?:^|[\\/])profiles[\\/][^\\/]+[\\/]node_modules[\\/]/u;
/**
 * Recognize the child-process profile-peer failure in one tool result's text.
 * @param text - the failure text to classify.
 * @param context - the running profile, when known.
 * @returns the recognized failure, or undefined when the text is not this one.
 */
export function classifyChildModuleFailure(text, context = {}) {
    if (!CHILD_MARKERS.some(marker => text.includes(marker)))
        return undefined;
    if (!text.includes(MODULE_NOT_FOUND))
        return undefined;
    for (const match of text.matchAll(NOT_FOUND)) {
        const specifier = match[1] ?? match[3];
        if (specifier === undefined)
            continue;
        const packageName = barePackageName(specifier);
        if (packageName === undefined)
            continue;
        const importer = normalizeImporter(match[2]);
        if (importer === undefined) {
            // Without an importer there is no way to tell a profile tree from any
            // other, and this plugin's advice is only true of a profile tree.
            continue;
        }
        const inProfile = context.profileDir !== undefined && insideDirectory(importer, context.profileDir);
        if (!inProfile && !PROFILE_MODULES_SHAPE.test(importer))
            continue;
        return { kind: 'profile-peer-missing', packageName, importer, importerInProfile: inProfile };
    }
    return undefined;
}
/**
 * The package root of a specifier, or undefined when it is not a bare package.
 * @param specifier - the specifier Node named.
 * @returns the package name, when the miss is a whole package.
 */
export function barePackageName(specifier) {
    if (specifier.length === 0)
        return undefined;
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':'))
        return undefined;
    if (specifier.includes('\\'))
        return undefined;
    // A package root only: `@scope/name` or `name`, never `name/subpath`, and never
    // a scope on its own (a specifier that starts with `@` and has no `/` is not a
    // package, whatever else it is).
    if (specifier.startsWith('@'))
        return /^@[^/\s]+\/[^/\s]+$/u.test(specifier) ? specifier : undefined;
    return /^[^/\s]+$/u.test(specifier) ? specifier : undefined;
}
/** Normalize the importer Node printed (it is a path or a `file:` URL). */
function normalizeImporter(raw) {
    if (raw === undefined)
        return undefined;
    const decoded = raw.startsWith('file://') ? decodeURIComponent(raw.slice('file://'.length)) : raw;
    return decoded.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(decoded) ? decoded : undefined;
}
/** Whether `path` is `directory` itself or lies inside it. */
function insideDirectory(path, directory) {
    const normalized = directory.endsWith('/') ? directory.slice(0, -1) : directory;
    return path === normalized || path.startsWith(`${normalized}/`);
}
