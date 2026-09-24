/**
 * The scan: what a bare child process would find, along the walk it performs.
 *
 * Both sub-cases of the retired writer are exercised on a real tree — a machine
 * that once ran 0.1.6 and kept its dangling links, and a machine that never did
 * and has no shared fallback directory at all — because the two need different
 * repairs and the scan has to be right about both.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createInstallationResolver } from '../lib/index.js'
import { describeCandidate, installedPackages, probeName, scanProfileFallback } from '../lib/scan.js'
import { install, scenario, writeJson } from './harness.mjs'

/** The walk's three candidate directories, nearest first. */
function walkDirs(built) {
  return [
    join(built.profileDir, 'node_modules'),
    built.sharedModulesDir,
    join(built.home, 'node_modules'),
  ]
}

test('sub-case (b): no shared fallback directory at all — the peer is missing', () => {
  const built = scenario({ sharedDir: false, autoInstallPeers: false })
  const report = scanProfileFallback({
    profileDir: built.profileDir,
    home: built.home,
    installation: createInstallationResolver(built.facts.installAnchor),
  })
  assert.deepEqual(report.findings.map(finding => finding.name), ['@deepseek-ai/cordis'])
  const [finding] = report.findings
  assert.equal(finding.kind, 'peer')
  assert.deepEqual(finding.requiredBy, ['@deepseek-ai/dsh-subprocess'])
  assert.equal(finding.range, '^4.0.2')
  assert.equal(finding.probe.verdict, 'missing')
  assert.equal(finding.probe.candidates.length, 3, 'the whole walk is reported, not only its end')
  assert.deepEqual(finding.probe.candidates.map(candidate => candidate.kind), ['absent', 'absent', 'absent'])
  assert.equal(finding.installation.dir, join(built.installDir, 'node_modules', '@deepseek-ai/cordis'))
  assert.equal(finding.installation.version, '4.0.2')
  assert.equal(report.autoInstallPeers, false)
  assert.equal(report.required, 1)
})

test('sub-case (a): a dangling link left by 0.1.6 makes the walk continue past it', () => {
  const built = scenario({ dangling: ['@deepseek-ai/cordis'] })
  const report = scanProfileFallback({ profileDir: built.profileDir, home: built.home })
  const [finding] = report.findings
  assert.equal(finding.probe.verdict, 'dangling', 'every candidate was a dead link, so the walk ended unresolved')
  assert.deepEqual(finding.probe.candidates.map(candidate => candidate.kind), ['absent', 'dangling', 'absent'])
  assert.match(finding.probe.candidates[1].evidence, /dangling symlink: .* -> .*gone/)
  assert.equal(report.notes.includes('no installation resolver was available, so bridgeable names cannot be identified'), true)
})

test('the walk continues past a dangling link to a live copy further up', () => {
  const built = scenario({ dangling: ['@deepseek-ai/cordis'] })
  install(join(built.home, 'node_modules'), '@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', version: '4.0.2' })
  // This is why a stale link is often harmless: Node stats the candidate before
  // it decides, a dead link fails that stat, and the walk keeps going.
  const probe = probeName('@deepseek-ai/cordis', walkDirs(built))
  assert.equal(probe.verdict, 'ok')
  assert.equal(probe.candidates.length, 3, 'every directory up to the live copy is visited')
  assert.equal(probe.candidates[1].kind, 'dangling')
  assert.equal(probe.loaded, join(built.home, 'node_modules', '@deepseek-ai/cordis'))
  const report = scanProfileFallback({
    profileDir: built.profileDir,
    home: built.home,
    installation: createInstallationResolver(built.facts.installAnchor),
  })
  assert.deepEqual(report.findings, [], 'a dead link the walk passes is not a failure')
})

test('the walk stops at the first candidate that is neither absent nor dangling', () => {
  const built = scenario()
  install(join(built.sharedModulesDir), '@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', version: '4.0.2' })
  install(join(built.home, 'node_modules'), '@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', version: '9.9.9' })
  const probe = probeName('@deepseek-ai/cordis', walkDirs(built))
  assert.equal(probe.verdict, 'ok')
  assert.equal(probe.candidates.length, 2, 'the third directory is never consulted')
  assert.equal(probe.candidates[1].version, '4.0.2', 'the nearest copy is the one a child loads')
})

test('a name resolved by the profile own node_modules is not a finding', () => {
  const built = scenario()
  install(join(built.profileDir, 'node_modules'), '@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', version: '4.0.2' })
  const report = scanProfileFallback({ profileDir: built.profileDir, home: built.home })
  assert.deepEqual(report.findings, [])
  assert.equal(report.required, 1)
})

test('an entry that stats but is not loadable is unresolved, not healthy', () => {
  const built = scenario()
  // A directory without a manifest: ESM has no index.js fallback for a bare
  // specifier, so a child would fail here too.
  mkdirSync(join(built.sharedModulesDir, '@deepseek-ai/cordis'), { recursive: true })
  const report = scanProfileFallback({ profileDir: built.profileDir, home: built.home })
  assert.equal(report.findings[0].probe.verdict, 'unresolved')
  assert.match(report.findings[0].probe.candidates[1].evidence, /no readable package\.json/)
})

test('a dsh-managed module proxy is recognized, and a stale one is not healthy', () => {
  const built = scenario()
  const proxyDir = join(built.sharedModulesDir, '@deepseek-ai/cordis')
  const live = join(built.root, 'live-target')
  writeJson(join(live, 'package.json'), { name: '@deepseek-ai/cordis', version: '4.0.2' })
  writeJson(join(proxyDir, 'package.json'), {
    name: '@deepseek-ai/cordis',
    version: '4.0.2',
    dsh: { moduleFallback: { targets: { main: live } } },
  })
  assert.equal(describeCandidate(proxyDir).kind, 'proxy')
  assert.deepEqual(scanProfileFallback({ profileDir: built.profileDir, home: built.home }).findings, [])

  // Now the generation it pointed at is gone.
  writeJson(join(proxyDir, 'package.json'), {
    name: '@deepseek-ai/cordis',
    version: '4.0.2',
    dsh: { moduleFallback: { targets: { main: join(built.root, 'gone-target') } } },
  })
  const stale = scanProfileFallback({ profileDir: built.profileDir, home: built.home })
  assert.equal(stale.findings[0].probe.verdict, 'stale-proxy')
  assert.match(stale.findings[0].probe.candidates[1].evidence, /stale dsh module proxy/)
})

test('a name declared as both a peer and a dependency is reported as a peer', () => {
  const built = scenario({ declares: { '@deepseek-ai/cordis': '^4.0.2' } })
  writeJson(join(built.profileDir, 'node_modules', '@deepseek-ai/dsh-subprocess', 'package.json'), {
    name: '@deepseek-ai/dsh-subprocess',
    version: '0.1.7-rc.1',
    dependencies: { '@deepseek-ai/cordis': '^4.0.2' },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.2' },
  })
  const report = scanProfileFallback({ profileDir: built.profileDir, home: built.home })
  assert.equal(report.findings[0].kind, 'peer', 'the axis whose remedy this plugin carries wins')
})

test('two declarers with different ranges leave the range unstated', () => {
  const built = scenario()
  writeJson(join(built.profileDir, 'node_modules', '@deepseek-ai/dsh-subprocess', 'package.json'), {
    name: '@deepseek-ai/dsh-subprocess',
    version: '0.1.7-rc.1',
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.2' },
  })
  install(join(built.profileDir, 'node_modules'), '@deepseek-ai/dsh-llm', {
    name: '@deepseek-ai/dsh-llm',
    version: '0.1.7-rc.1',
    peerDependencies: { '@deepseek-ai/cordis': '^5.0.0' },
  })
  const report = scanProfileFallback({ profileDir: built.profileDir, home: built.home })
  assert.equal(report.findings[0].range, undefined)
  assert.deepEqual(report.findings[0].requiredBy, ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-subprocess'])
})

test('extra names are probed even when nothing local declares them', () => {
  const built = scenario({ declares: {} })
  const report = scanProfileFallback({
    profileDir: built.profileDir,
    home: built.home,
    extraNames: ['@deepseek-ai/cordis'],
  })
  assert.deepEqual(report.findings.map(finding => finding.name), ['@deepseek-ai/cordis'])
  assert.deepEqual(report.findings[0].requiredBy, [])
})

test('the report states its own limits', () => {
  const built = scenario()
  const report = scanProfileFallback({ profileDir: built.profileDir, home: built.home })
  assert.equal(
    report.notes.some(note => note.includes('only the top level of the profile node_modules is inspected')),
    true,
  )
})

test('autoInstallPeers is read as a setting, not guessed from the failure', () => {
  assert.equal(scanProfileFallback({ profileDir: scenario({ autoInstallPeers: true }).profileDir, home: '/' }).autoInstallPeers, true)
  assert.equal(scanProfileFallback({ profileDir: scenario({ autoInstallPeers: false }).profileDir, home: '/' }).autoInstallPeers, false)
  assert.equal(scanProfileFallback({ profileDir: scenario().profileDir, home: '/' }).autoInstallPeers, undefined)
})

test('a profile with nothing installed reports no requirements and says so', () => {
  const built = scenario()
  rmSync(join(built.profileDir, 'node_modules'), { recursive: true })
  const report = scanProfileFallback({ profileDir: built.profileDir, home: built.home })
  assert.equal(report.required, 0)
  assert.deepEqual(report.findings, [])
  assert.equal(report.notes.some(note => note.includes('no readable package is installed')), true)
})

test('installedPackages reads through links and skips dangling ones', () => {
  const built = scenario()
  const scoped = install(join(built.root, 'elsewhere', 'node_modules'), '@scope/pkg', { name: '@scope/pkg', version: '1.0.0' })
  mkdirSync(join(built.profileDir, 'node_modules', '@scope'), { recursive: true })
  symlinkSync(scoped, join(built.profileDir, 'node_modules', '@scope', 'pkg'), 'dir')
  symlinkSync(join(built.root, 'gone', 'dead'), join(built.profileDir, 'node_modules', '@scope', 'dead'))
  const names = installedPackages(built.profileDir).map(entry => entry.name)
  assert.deepEqual(names, ['@deepseek-ai/dsh-subprocess', '@scope/pkg'], 'a dead link declares nothing')
})

test('the installation resolver walks up from its anchor and checks the declared name', () => {
  const built = scenario()
  const resolve = createInstallationResolver(built.facts.installAnchor)
  assert.equal(resolve('@deepseek-ai/cordis').dir, join(built.installDir, 'node_modules', '@deepseek-ai/cordis'))
  assert.equal(resolve('not-installed-anywhere'), undefined)
  // A directory at the right path whose manifest declares something else is not
  // the package being looked for.
  const impostor = join(built.installDir, 'node_modules', 'impostor')
  mkdirSync(impostor, { recursive: true })
  writeFileSync(join(impostor, 'package.json'), '{"name":"something-else"}\n')
  assert.equal(resolve('impostor'), undefined)
  // An unreadable manifest is not a package either.
  mkdirSync(join(built.installDir, 'node_modules', 'broken'), { recursive: true })
  writeFileSync(join(built.installDir, 'node_modules', 'broken', 'package.json'), '{ not json')
  assert.equal(resolve('broken'), undefined)
})

test('the walk reports a candidate directory it cannot even stat', () => {
  const built = scenario()
  const probe = probeName('@deepseek-ai/nothing-here', walkDirs(built))
  assert.equal(probe.verdict, 'missing')
  assert.equal(probe.candidates[0].evidence, `absent: ${join(built.profileDir, 'node_modules', '@deepseek-ai/nothing-here')}`)
})

test('a file where a package belongs is not loadable', () => {
  const built = scenario()
  const path = join(built.sharedModulesDir, '@deepseek-ai/cordis')
  mkdirSync(join(built.sharedModulesDir, '@deepseek-ai'), { recursive: true })
  writeFileSync(path, 'not a package\n')
  const candidate = describeCandidate(path)
  assert.equal(candidate.kind, 'not-a-package')
  assert.match(candidate.evidence, /not a directory/)
})

test('an unreadable symlink target is reported as dangling, not as a crash', () => {
  const built = scenario()
  const path = join(built.profileDir, 'node_modules', 'loop')
  symlinkSync(path, path)
  const candidate = describeCandidate(path)
  assert.equal(candidate.kind, 'dangling')
  assert.match(candidate.evidence, /dangling symlink/)
  assert.equal(candidate.resolved, undefined)
})

test('an unscoped node_modules entry with no manifest is skipped entirely', () => {
  const built = scenario()
  mkdirSync(join(built.profileDir, 'node_modules', '.bin'), { recursive: true })
  assert.deepEqual(installedPackages(built.profileDir).map(entry => entry.name), ['@deepseek-ai/dsh-subprocess'])
  assert.equal(readdirSync(join(built.profileDir, 'node_modules')).includes('.bin'), true)
  assert.equal(existsSync(join(built.profileDir, 'pnpm-workspace.yaml')), false, 'no settings file is invented')
})
