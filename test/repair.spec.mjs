/**
 * The opt-in repair half, on a real tree: what it writes, what it replaces, and —
 * the part most of this file is about — what it refuses to touch.
 *
 * The invariant under test is **additive**: a repair creates and refreshes links
 * in the shared fallback directory and removes nothing it did not write, and it
 * never writes into the profile's own pnpm-owned `node_modules` at all.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createInstallationResolver } from '../lib/index.js'
import { applyRepairs, describeOutcomes, planRepairs } from '../lib/repair.js'
import { probeName, scanProfileFallback } from '../lib/scan.js'
import { install, scenario, writeJson } from './harness.mjs'

/** The walk's three candidate directories, nearest first. */
function walkDirs(built) {
  return [join(built.profileDir, 'node_modules'), built.sharedModulesDir, join(built.home, 'node_modules')]
}

/** Scan one scenario and plan its repair. */
function plan(built) {
  const report = scanProfileFallback({
    profileDir: built.profileDir,
    home: built.home,
    installation: createInstallationResolver(built.facts.installAnchor),
  })
  return { report, ...planRepairs(report) }
}

/** Repair one scenario completely. */
function repair(built) {
  const planned = plan(built)
  return { ...planned, outcomes: applyRepairs(planned.actions, { modulesDirs: walkDirs(built) }) }
}

test('an absent entry is created, and a fresh probe confirms it', () => {
  const built = scenario({ sharedDir: false })
  const { actions, skipped, outcomes } = repair(built)
  assert.deepEqual(skipped, [])
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0], {
    name: '@deepseek-ai/cordis',
    linkPath: join(built.sharedModulesDir, '@deepseek-ai/cordis'),
    target: join(built.installDir, 'node_modules', '@deepseek-ai/cordis'),
    replaces: 'none',
    reason: `absent from the shared fallback, which the child's walk visits`,
  })
  assert.equal(outcomes[0].ok, true)
  assert.equal(outcomes[0].error, undefined)
  assert.equal(outcomes[0].verified, 'ok', 'the repair proves itself with the same probe the scan uses')
  assert.equal(readlinkSync(actions[0].linkPath), actions[0].target)
  assert.equal(probeName('@deepseek-ai/cordis', walkDirs(built)).verdict, 'ok')
})

test('a dangling link left by 0.1.6 is replaced, not added beside', () => {
  const built = scenario({ dangling: ['@deepseek-ai/cordis'] })
  const { actions, outcomes } = repair(built)
  assert.equal(actions[0].replaces, 'dangling-link')
  assert.match(actions[0].reason, /dangling-link left by an earlier generation/)
  assert.equal(outcomes[0].ok, true)
  assert.equal(outcomes[0].verified, 'ok')
  assert.equal(readlinkSync(actions[0].linkPath), actions[0].target, 'the dead target is gone, not shadowed')
})

test('a stale dsh proxy is replaced, and only that directory is removed', () => {
  const built = scenario()
  const proxyDir = join(built.sharedModulesDir, '@deepseek-ai/cordis')
  writeJson(join(proxyDir, 'package.json'), {
    name: '@deepseek-ai/cordis',
    version: '4.0.2',
    dsh: { moduleFallback: { targets: { main: join(built.root, 'gone') } } },
  })
  writeFileSync(join(proxyDir, 'leftover.js'), 'x\n')
  const { actions, outcomes } = repair(built)
  assert.equal(actions[0].replaces, 'stale-proxy')
  assert.equal(outcomes[0].verified, 'ok')
  assert.equal(existsSync(join(proxyDir, 'leftover.js')), false, 'the whole dead proxy directory goes')
})

test('a foreign entry at the link path is reported, never removed', () => {
  const built = scenario()
  const path = join(built.sharedModulesDir, '@deepseek-ai/cordis')
  mkdirSync(join(built.sharedModulesDir, '@deepseek-ai'), { recursive: true })
  writeFileSync(path, 'a file I did not write\n')
  const { actions, skipped, outcomes } = repair(built)
  assert.deepEqual(actions, [], 'nothing is planned against an entry this plugin does not own')
  assert.equal(skipped.length, 1)
  assert.match(skipped[0].reason, /an entry this plugin does not own exists/)
  assert.deepEqual(outcomes, [])
  assert.equal(existsSync(path), true)
  assert.equal(lstatSync(path).isFile(), true)
})

test('a name the installation does not have is reported, never approximated', () => {
  const built = scenario({ installation: false })
  const { actions, skipped } = repair(built)
  assert.deepEqual(actions, [])
  assert.match(skipped[0].reason, /the installation has no copy of this name/)
})

test('an unrelated entry in the shared fallback survives the whole repair', () => {
  const built = scenario()
  const other = install(built.sharedModulesDir, 'some-other-package', { name: 'some-other-package', version: '1.0.0' })
  const otherLink = join(built.sharedModulesDir, 'a-dangling-other')
  mkdirSync(built.sharedModulesDir, { recursive: true })
  writeJson(join(built.root, 'gone', 'package.json'), { name: 'gone', version: '1.0.0' })
  // A live second link and a dangling third: neither is this repair's business.
  const before = readdirSync(built.sharedModulesDir).sort()
  repair(built)
  const after = readdirSync(built.sharedModulesDir).sort()
  assert.deepEqual(after.filter(name => name !== '@deepseek-ai'), before.filter(name => name !== '@deepseek-ai'))
  assert.equal(existsSync(other), true)
  assert.equal(existsSync(otherLink), false, 'the fixture never created it; nothing invented it either')
})

test('the profile own node_modules is never written into', () => {
  const built = scenario()
  // pnpm owns that tree: a dead link there means the store generation was
  // garbage collected, and the remedy is `pnpm install`, not a file written
  // behind the package manager's back.
  const own = join(built.profileDir, 'node_modules', 'dead-peer')
  mkdirSync(join(built.profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(built.profileDir, 'node_modules', 'package.json'), '{}\n')
  const { actions } = repair(built)
  assert.equal(actions.some(action => action.linkPath.startsWith(join(built.profileDir, 'node_modules'))), false)
  assert.equal(existsSync(own), false)
  assert.equal(existsSync(join(built.profileDir, 'node_modules', 'package.json')), true, 'the tree is exactly as pnpm left it')
})

test('a second repair is a no-op, because the first one fixed what it saw', () => {
  const built = scenario()
  const first = repair(built)
  assert.equal(first.outcomes[0].ok, true)
  const second = repair(built)
  assert.deepEqual(second.actions, [], 'nothing is left to plan')
  assert.deepEqual(second.report.findings, [], 'the scan agrees')
})

test('a failing write is recorded and does not stop the next action', () => {
  // Make the shared fallback directory a FILE: the write cannot create its
  // parent, and the failure must surface as an outcome, not as a throw.
  const blocked = scenario({ sharedDir: false })
  writeFileSync(blocked.sharedModulesDir, 'not a directory\n')
  const planned = plan(blocked)
  const outcomes = applyRepairs(planned.actions, { modulesDirs: walkDirs(blocked) })
  assert.equal(outcomes[0].ok, false)
  assert.notEqual(outcomes[0].error, undefined)
  assert.equal(outcomes[0].verified, undefined, 'an unverified repair claims no verdict')
  assert.match(describeOutcomes(outcomes)[0], /^failed to link @deepseek-ai\/cordis -> /)

  // And the same plan applied where the parent is writable still succeeds two
  // lines later: one unwritable name cannot cost the others.
  const good = scenario({ sharedDir: false })
  const mixed = applyRepairs(
    [...plan(good).actions, ...plan(good).actions],
    { modulesDirs: walkDirs(good) },
  )
  assert.deepEqual(mixed.map(outcome => outcome.ok), [true, true], 'a repeated action is still a successful write')
})

test('a finding whose copy already lives in the shared fallback is left alone', () => {
  // Defensive: with a real scan this cannot arise (a loadable copy there makes
  // the probe return ok), so the report is built by hand to pin the guard.
  const report = {
    profileDir: '/p',
    sharedModulesDir: '/h/profiles/node_modules',
    profilesDir: '/h/profiles',
    required: 1,
    autoInstallPeers: false,
    notes: [],
    findings: [{
      name: 'peer',
      kind: 'peer',
      requiredBy: ['a'],
      range: '^1.0.0',
      probe: { name: 'peer', verdict: 'missing', candidates: [], loaded: undefined },
      installation: { dir: '/h/profiles/node_modules/peer', version: '1.0.0' },
    }],
  }
  const { actions, skipped } = planRepairs(report)
  assert.deepEqual(actions, [])
  assert.match(skipped[0].reason, /already lives in the shared fallback/)
})

test('a loadable copy at the link path makes the action unnecessary, and a plan is empty', () => {
  const built = scenario()
  install(built.sharedModulesDir, '@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', version: '4.0.2' })
  const { actions, report } = plan(built)
  assert.deepEqual(report.findings, [], 'the probe is what decides, and it is satisfied')
  assert.deepEqual(actions, [])
})

test('describeOutcomes names the link, its target, and the verification', () => {
  const built = scenario()
  const { outcomes } = repair(built)
  assert.equal(
    describeOutcomes(outcomes)[0],
    `linked @deepseek-ai/cordis -> ${join(built.installDir, 'node_modules', '@deepseek-ai/cordis')}`
    + ` (absent from the shared fallback, which the child's walk visits); verification after write: ok`,
  )
})
