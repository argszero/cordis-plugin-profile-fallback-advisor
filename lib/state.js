/**
 * Per-agent bookkeeping.
 *
 * The unit of delivery is the **agent**, not the process: one advisory per agent
 * is enough for the model to stop retrying, and repeating it on every failing
 * call would spend the session's context on the same paragraph. Keyed on the
 * agent object the tool pipeline hands the waterfall, so a second agent in the
 * same process (a subagent, another session) is its own first time.
 *
 * The ledger is created **per mount** rather than at module scope: a process can
 * mount this plugin more than once (tests do), and module-level state would make
 * one mount's first failure silence another mount's advisory.
 *
 * Nothing here is durable. There is no session event to fold and none is wanted:
 * the advisory rides the failing result itself, and a process restart re-derives
 * the whole decision from the filesystem.
 *
 * @module @argszero/cordis-plugin-profile-fallback-advisor
 */
/**
 * Create one mount's ledger.
 * @returns the ledger, backed by a WeakMap so a finished agent stays collectable.
 */
export function createAdviceLedger() {
    const states = new WeakMap();
    return {
        claim: (agent) => {
            const existing = states.get(agent);
            if (existing === undefined) {
                states.set(agent, { advised: true, suppressed: 0 });
                return true;
            }
            if (existing.advised) {
                existing.suppressed += 1;
                return false;
            }
            existing.advised = true;
            return true;
        },
        suppressed: (agent) => states.get(agent)?.suppressed ?? 0,
        advised: (agent) => states.get(agent)?.advised === true,
    };
}
