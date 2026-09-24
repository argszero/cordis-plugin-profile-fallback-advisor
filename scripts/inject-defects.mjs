/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with tsc
 * first; a mutation that fails to type-check proves nothing either and is
 * reported separately.
 *
 * Every mutation here is a defect this plugin could plausibly ship, not a
 * mutation engineered to be caught: drop a gate, swap a read, widen a write,
 * share state that should be per-mount. One of them is recorded as EQUIVALENT
 * with its reason, because "we tried to make this arm bite and could not" is a
 * fact about the arm.
 *
 * Run from the plugin root: `npm run test:inject`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: 'the child-exit marker is no longer required, so any module miss in a profile path is claimed',
    file: 'src/signature.ts',
    arms: 'signature.spec.mjs',
    edits: [['if (!CHILD_MARKERS.some(marker => text.includes(marker))) return undefined', 'if (false) return undefined']],
  },
  {
    name: 'a scope alone is accepted as a package name',
    file: 'src/signature.ts',
    arms: 'signature.spec.mjs',
    edits: [["if (specifier.startsWith('@')) return /^@[^/\\s]+\\/[^/\\s]+$/u.test(specifier) ? specifier : undefined", "if (specifier.startsWith('@')) return /^@[^/\\s]+(\\/[^/\\s]+)?$/u.test(specifier) ? specifier : undefined"]],
  },
  {
    name: 'the walk stops at a dangling link instead of continuing past it',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [["    if (found.kind === 'absent' || found.kind === 'dangling') continue", "    if (found.kind === 'absent') continue"]],
  },
  {
    name: 'a dangling link is read with readFileSync, so its evidence loses the dead target',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [['    return readlinkSync(path)', '    return readFileSync(path, \'utf8\')']],
  },
  {
    name: 'a foreign entry at the link path is treated as replaceable and overwritten',
    file: 'src/repair.ts',
    arms: 'repair.spec.mjs',
    edits: [["  const replaces: Replacement | undefined = existing.kind === 'absent'", "  const replaces: Replacement | undefined = existing.kind === 'absent' || existing.kind === 'not-a-package'"]],
  },
  {
    name: 'the repair writes into the profile own node_modules, which pnpm owns',
    file: 'src/repair.ts',
    arms: 'repair.spec.mjs',
    edits: [['  const linkPath = join(report.sharedModulesDir, finding.name)', '  const linkPath = join(report.profileDir, \'node_modules\', finding.name)']],
  },
  {
    name: 'the advisory is delivered on every failure instead of once per agent',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [['    if (!ledger.claim(agent)) return undefined', '    ledger.claim(agent)']],
  },
  {
    name: 'the repair runs even when the mount did not ask for it',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [['  const facts = boot(ctx, repairEnabled, extraNames)', '  const facts = boot(ctx, true, extraNames)']],
  },
  {
    name: 'the pnpm remedy names the opposite value of the setting that causes the defect',
    file: 'src/advice.ts',
    arms: 'plugin.spec.mjs',
    edits: [["      `  1. Let pnpm install the peers into the profile: add \\`${AUTO_INSTALL_PEERS}: true\\` to`,", "      `  1. Let pnpm install the peers into the profile: add \\`${AUTO_INSTALL_PEERS}: false\\` to`,"]],
  },
  {
    name: 'the advice bookkeeping is module-level instead of per mount',
    file: 'src/state.ts',
    arms: 'plugin.spec.mjs',
    edits: [['  const states = new WeakMap<object, AgentState>()', '  const states = SHARED_STATES']],
    // The mutation needs its own carrier for the shared map, which `edits`
    // cannot express, so it is declared here as a two-step source rewrite.
    extra: [['export function createAdviceLedger(): AdviceLedger {', 'const SHARED_STATES = new WeakMap<object, AgentState>()\nexport function createAdviceLedger(): AdviceLedger {']],
  },
  {
    // EQUIVALENT MUTANT, recorded rather than hidden: the fixture throws one
    // `Error` whose message IS the whole two-line failure, so `error.message` and
    // the merged text (message + rendered content) are the same string, and no
    // fixture in this suite can tell the two reads apart. Kept in the list
    // because the narrower read is still the right one for a result whose content
    // was replaced by another listener — an effect this suite cannot produce.
    name: 'the classifier reads only error.message instead of the merged text',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    equivalent: 'the fixture carries no second copy of the text, so the two reads agree',
    edits: [['      failureText(result),', '      result.error.message,']],
  },
]

let silent = 0
let unbuildable = 0
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of [...mutation.extra ?? [], ...mutation.edits]) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) continue

  const build = () => {
    try {
      execFileSync('npx', ['tsc'], { cwd: ROOT, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  writeFileSync(path, mutated)
  let built = false
  let failed = false
  let output = ''
  try {
    built = build()
    if (built) {
      try {
        execFileSync('node', ['--test', `test/${mutation.arms}`], { cwd: ROOT, stdio: 'pipe' })
      } catch (error) {
        failed = true
        output = String(error.stdout ?? '') + String(error.stderr ?? '')
      }
    }
  } finally {
    // The source is restored and rebuilt whatever happened: an injector that can
    // leave a mutation in the tree is worse than no injector.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  const caught = failed && new RegExp('fail [1-9]').test(output)
  if (!caught && mutation.equivalent === undefined) silent += 1
  const label = caught ? 'CAUGHT' : mutation.equivalent === undefined ? 'SILENT' : 'EQUIVALENT'
  console.log(`${label}: ${mutation.name} (${mutation.arms})${caught || mutation.equivalent === undefined ? '' : ` — ${mutation.equivalent}`}`)
}
console.log(`SILENT ARMS: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${String(unbuildable)}`)
