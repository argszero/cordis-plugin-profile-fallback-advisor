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
/** What is remembered about one agent. */
export interface AgentState {
    /** Whether this agent has already been given the advisory. */
    advised: boolean;
    /** How many recognized failures were left untouched because of it. */
    suppressed: number;
}
/** The per-mount ledger. */
export interface AdviceLedger {
    /**
     * Claim the advisory for one agent.
     * @param agent - the agent identity.
     * @returns true for the first claim, false afterwards.
     */
    claim: (agent: object) => boolean;
    /** How many recognized failures one agent's advisory has suppressed. */
    suppressed: (agent: object) => number;
    /** Whether one agent has already been advised. */
    advised: (agent: object) => boolean;
}
/**
 * Create one mount's ledger.
 * @returns the ledger, backed by a WeakMap so a finished agent stays collectable.
 */
export declare function createAdviceLedger(): AdviceLedger;
