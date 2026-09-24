/**
 * The reported failure, end to end: mount the plugin on the shared harness
 * (`./harness.mjs` — a real cordis context, the real `dsh-tools` ToolRuntime,
 * the real `tools/post-execute` waterfall, and a real profile tree on disk) and
 * drive calls through the actual seam.
 *
 * This suite owns the mount: recognition through the waterfall, once-per-agent
 * delivery, what the advisory says, the boot scan's log lines, the opt-in
 * repair against a real tree, the watching lists, and the arm where there is no
 * launcher to ask.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

import * as plugin from '../lib/index.js'
import {
  call,
  contexts,
  failingTool,
  logLines,
  logText,
  noticeText,
  okTool,
  reportedText,
  scenario,
  signal,
  text,
  who,
  world,
} from './harness.mjs'

test('exposes the documented plugin surface', () => {
  assert.equal(plugin.name, 'profile-fallback-advisor')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(plugin.SOURCE_KIND, 'profile-fallback-advisor')
  assert.equal(plugin.PROFILE_CONTEXT, 'profileContext')
})

test('the reported failure is settled with the diagnosis beside it', async () => {
  const built = scenario({ autoInstallPeers: false })
  const { ctx, logged } = await world(undefined, [failingTool('bash', reportedText())], { profile: built.facts })
  const result = await call(ctx, 'bash', { code: '1 + 1' })
  assert.equal(result.isError, true)
  assert.match(text(result), /bootstrap consumed the launch request/, 'the original failure is preserved, not replaced')
  const attached = contexts(result)
  assert.equal(attached.length, 1, 'exactly one context rides the failure')
  const [notice] = attached
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'profile-fallback-advisor', 'the producer declares its own source kind')
  assert.equal(notice.source.form, 'notice')
  assert.ok(notice.source.summary.length > 0 && notice.source.summary.length <= 120, 'the notice row stays one line')
  assert.equal(typeof notice.id, 'string')
  const body = noticeText(result)
  assert.match(body, /could not start because a package installed into this profile cannot resolve a peer/)
  assert.match(body, /the child failed on: @deepseek-ai\/cordis/)
  assert.match(body, /imported from: .*profiles\/dev\/node_modules/)
  assert.match(body, /required by: @deepseek-ai\/dsh-subprocess \(\^4\.0\.2\)/)
  assert.match(body, /shared peer fallback: .*profiles\/node_modules/)
  assert.match(body, /profile sets autoInstallPeers: false in .*pnpm-workspace\.yaml/)
  assert.match(body, /autoInstallPeers: true/, 'the first remedy is the pnpm setting')
  assert.match(body, /repair: true/, 'the second remedy is the plugin mount')
  assert.match(body, /Retrying this call cannot help/)
  assert.match(body, /What does not help: retrying this call, setting `NODE_PATH`/)
  assert.match(body, /Stop retrying this tool and tell the user which option they want\./)
  // The host-side account exists too, so the transcript is not the only record.
  assert.equal(logLines(logged, 'profile-fallback-advisor: a child process failed on').length, 1)
})

test('the boot scan reports its findings, and the limits it does not cover', async () => {
  const built = scenario({ autoInstallPeers: false })
  const { logged } = await world(undefined, [], { profile: built.facts })
  const lines = logLines(logged, 'profile-fallback-advisor:')
  assert.equal(lines.some(line => /1 of 1 required name\(s\) are unresolvable/.test(line)), true)
  assert.equal(logLines(logged, '  - @deepseek-ai/cordis (peer, required by @deepseek-ai/dsh-subprocess)').length, 1)
  assert.equal(logText(logged).includes('only the top level of the profile node_modules is inspected'), true)
})

test('a healthy profile says so at boot, so silence and a scan are distinguishable', async () => {
  const built = scenario({ resolved: true })
  const { logged } = await world(undefined, [], { profile: built.facts })
  const lines = logLines(logged, 'profile-fallback-advisor:')
  assert.equal(lines.some(line => line.includes('1 required name(s) resolve for a bare child process')), true)
  assert.equal(logText(logged).includes('unresolvable'), false)
})

test('the advisory is delivered once per agent, not once per failing call', async () => {
  const built = scenario()
  const { ctx, logged } = await world(undefined, [failingTool('bash', reportedText())], { profile: built.facts })
  assert.equal(contexts(await call(ctx, 'bash', { code: 'a' })).length, 1)
  for (const code of ['b', 'c', 'd']) {
    const again = await call(ctx, 'bash', { code })
    assert.equal(again.isError, true)
    assert.equal(contexts(again).length, 0, 'the profile is explained once; repetition is noise')
  }
  assert.equal(logLines(logged, 'a child process failed on').length, 1, 'the host-side line is not repeated either')
})

test('a second agent gets its own advisory', async () => {
  const built = scenario()
  const { ctx } = await world(undefined, [failingTool('bash', reportedText())], { profile: built.facts })
  assert.equal(contexts(await call(ctx, 'bash', {}, who('a1'))).length, 1)
  assert.equal(contexts(await call(ctx, 'bash', {}, who('a2'))).length, 1)
})

test('a direct execute() with no agent is never advised', async () => {
  const built = scenario()
  const { ctx } = await world(undefined, [failingTool('bash', reportedText())], { profile: built.facts })
  const result = await ctx.tools.execute({ name: 'bash', arguments: {}, signal: signal() })
  assert.equal(result.isError, true)
  assert.equal(contexts(result).length, 0, 'no agent means no session to explain anything to')
})

test('an unrelated failure is left exactly as it was', async () => {
  const built = scenario()
  const { ctx, logged } = await world(undefined, [failingTool('edit', 'old_string and new_string must differ')], { profile: built.facts })
  const result = await call(ctx, 'edit', { old_string: 'a', new_string: 'a' })
  assert.equal(result.isError, true)
  assert.equal(contexts(result).length, 0)
  assert.match(text(result), /must differ/)
  assert.equal(logLines(logged, 'a child process failed').length, 0)
})

test('a SUCCESS whose output quotes the signature is not advised', async () => {
  // Reading a log file that happens to contain the two lines must not trigger
  // advice: the gate is the result's error state, not the presence of the text.
  const built = scenario()
  const { ctx, logged } = await world(undefined, [okTool('read_file', `build.log: ${reportedText()}`)], { profile: built.facts })
  const result = await call(ctx, 'read_file', { path: 'build.log' })
  assert.equal(result.isError, false)
  assert.equal(contexts(result).length, 0)
  assert.equal(logLines(logged, 'a child process failed').length, 0)
})

test('include and exclude lists narrow what is watched', async () => {
  const built = scenario()
  const excluded = await world({ exclude: ['bash'] }, [failingTool('bash', reportedText())], { profile: built.facts })
  assert.equal(contexts(await call(excluded.ctx, 'bash', {})).length, 0)

  const included = await world({ include: ['speak*'] }, [failingTool('bash', reportedText()), failingTool('speak', reportedText())], { profile: built.facts })
  assert.equal(contexts(await call(included.ctx, 'bash', {})).length, 0)
  assert.equal(contexts(await call(included.ctx, 'speak', {})).length, 1)
})

test('a configured href is quoted at the end of the advisory', async () => {
  const built = scenario()
  const href = 'https://github.com/deepseek-ai/deepseek-harness/discussions/7635'
  const { ctx } = await world({ href }, [failingTool('bash', reportedText())], { profile: built.facts })
  assert.equal(noticeText(await call(ctx, 'bash', {})).trimEnd().endsWith(href), true)
})

test('with no launcher the advisory is honest that no scan was taken', async () => {
  // Not a claim that everything is fine: the reactive half still classifies, but
  // it must not imply the branch was examined in this process.
  const { ctx, logged } = await world(undefined, [failingTool('bash', reportedText())])
  const result = await call(ctx, 'bash', {})
  assert.equal(contexts(result).length, 1)
  const body = noticeText(result)
  assert.match(body, /the boot scan did not run in this process, so the branch above is named but not classified/)
  assert.match(body, /Add `autoInstallPeers: true` to this profile's pnpm-workspace\.yaml/)
  assert.equal(
    logLines(logged, 'no profileContext in this process, so no boot scan was taken').length,
    1,
    'the host log accounts for the silence',
  )
})

test('a name the scan did not have is named without borrowing another finding', async () => {
  const built = scenario()
  const { ctx } = await world(undefined, [failingTool('bash', reportedText(undefined, 'an-unknown-peer'))], { profile: built.facts })
  const body = noticeText(await call(ctx, 'bash', {}))
  assert.match(body, /the child failed on: an-unknown-peer/)
  assert.equal(body.includes('required by:'), false, 'the scan knows nothing about this name, and says nothing')
  assert.equal(body.includes('what the walk found:'), false)
  assert.match(body, /shared peer fallback: /, 'the paths it does know are still quoted')
  assert.match(body, /autoInstallPeers: true/, 'both remedies still apply: the cause is the same')
})

test('repair: false writes nothing at all', async () => {
  const built = scenario({ sharedDir: false })
  const { logged } = await world(undefined, [], { profile: built.facts })
  assert.equal(existsSync(built.sharedModulesDir), false, 'the default never creates the directory')
  assert.equal(logLines(logged, 'profile-fallback-advisor: linked').length, 0)
})

test('repair: true links the installation copies into the shared fallback', async () => {
  const built = scenario({ sharedDir: false, autoInstallPeers: false })
  const { logged } = await world({ repair: true }, [], { profile: built.facts })
  const link = join(built.sharedModulesDir, '@deepseek-ai/cordis')
  const target = join(built.installDir, 'node_modules', '@deepseek-ai/cordis')
  assert.equal(readlinkSync(link), target)
  const lines = logLines(logged, 'profile-fallback-advisor: linked @deepseek-ai/cordis')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /verification after write: ok/)

})

test('with repair on, the advisory reports what the boot repair did and did not fix', async () => {
  // One declared peer the installation owns and one it does not: the repair can
  // bridge the first and must say so, and the advisory for the second has to
  // distinguish "already linked" from "nothing can be linked".
  const built = scenario({ sharedDir: false, declares: { '@deepseek-ai/cordis': '^4.0.2', 'ghost-peer': '^1.0.0' } })
  const { ctx, logged } = await world(
    { repair: true },
    [failingTool('bash', reportedText(undefined, 'ghost-peer'))],
    { profile: built.facts },
  )
  const body = noticeText(await call(ctx, 'bash', {}))
  assert.match(body, /Repair is already enabled in this mount/)
  assert.match(body, /already repaired part of it at boot/)
  assert.match(body, /linked: @deepseek-ai\/cordis -> .*node_modules\/@deepseek-ai\/cordis/)
  assert.match(body, /required by: @deepseek-ai\/dsh-subprocess \(\^1\.0\.0\)/, 'the scan quotes the declaration for this name')
  assert.equal(
    logLines(logged, 'left "ghost-peer" alone').length,
    1,
    'and the name it could not bridge is reported to the host, not silently dropped',
  )
})

test('repair: true never deletes an entry it does not own', async () => {
  const built = scenario()
  const foreign = join(built.sharedModulesDir, 'a-foreign-directory')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(foreign, { recursive: true })
  const { logged } = await world({ repair: true }, [], { profile: built.facts })
  assert.equal(existsSync(foreign), true)
  assert.equal(logLines(logged, 'left "a-foreign-directory" alone').length, 0, 'it is not even a finding: nothing required it')
})

test('an internal error leaves the tool result alone instead of breaking the call', async () => {
  const broken = {
    logger: { info() {}, warn() {} },
    // `get` throwing is the harness's way of modelling a service store that
    // cannot answer; the boot half must swallow it and still register.
    get() { throw new Error('store unavailable') },
    on() {},
  }
  assert.doesNotThrow(() => { plugin.apply(broken, {}) })
})

test('an unreadable profile tree is a warning, not a failed mount', async () => {
  const { ctx, logged } = await world(undefined, [], { profile: { dir: 7, home: null, installAnchor: {} } })
  assert.equal(ctx.tools !== undefined, true, 'the plugin still mounted')
  assert.equal(logLines(logged, 'no profileContext in this process').length, 1, 'malformed facts read as absent facts')
})

test('the host line names the package, the importer and the discussion', async () => {
  const built = scenario()
  const { ctx, logged } = await world(undefined, [failingTool('bash', reportedText())], { profile: built.facts })
  await call(ctx, 'bash', {})
  const [line] = logLines(logged, 'a child process failed on')
  assert.match(line, /"@deepseek-ai\/cordis"/)
  assert.match(line, /imported from .*index\.js/)
  assert.match(line, /discussion 7635/)
  assert.equal(logText(logged).includes('undefined'), false)
})
