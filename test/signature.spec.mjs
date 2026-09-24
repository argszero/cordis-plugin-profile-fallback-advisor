/**
 * The reactive signature: which child-process failures this plugin claims, and —
 * more of the file than the positive arm — which it refuses.
 *
 * The refusal arms are the point. `ERR_MODULE_NOT_FOUND` is the most ordinary
 * error in Node and the wrapper fires for any early child death, so a classifier
 * that keys on either one alone would put a profile-shaped diagnosis in front of
 * failures it knows nothing about.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { barePackageName, classifyChildModuleFailure, CHILD_MARKERS, MODULE_NOT_FOUND } from '../lib/signature.js'
import { reportedText } from './harness.mjs'

const PROFILE_MODULES = '/home/.dsh/profiles/dev/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js'

test('the reported failure is recognized, with its package and its importer', () => {
  const failure = classifyChildModuleFailure(reportedText(PROFILE_MODULES))
  assert.equal(failure.kind, 'profile-peer-missing')
  assert.equal(failure.packageName, '@deepseek-ai/cordis')
  assert.equal(failure.importer, PROFILE_MODULES)
  assert.equal(failure.importerInProfile, false, 'no profile was declared, so nothing is claimed about which one')
})

test('a declared profile turns the same text into an in-profile finding', () => {
  const failure = classifyChildModuleFailure(reportedText(PROFILE_MODULES), { profileDir: '/home/.dsh/profiles/dev' })
  assert.equal(failure.importerInProfile, true)
})

test('both halves of the wrapper count as the child-exit marker', () => {
  for (const marker of CHILD_MARKERS) {
    const text = `${marker}\n[ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad'\n  imported from ${PROFILE_MODULES}`
    assert.equal(classifyChildModuleFailure(text).packageName, 'left-pad', marker)
  }
  assert.equal(MODULE_NOT_FOUND, 'ERR_MODULE_NOT_FOUND')
})

test('the child-exit marker alone is not enough', () => {
  // Every early child death produces it — a syntax error, an OOM, a native
  // mismatch. Without a module error there is nothing profile-shaped to say.
  assert.equal(classifyChildModuleFailure('code run failed (worker-exit): subprocess scope exited early'), undefined)
})

test('ERR_MODULE_NOT_FOUND alone is not enough', () => {
  assert.equal(classifyChildModuleFailure("Cannot find package 'left-pad'\n  imported from /app/src/index.js"), undefined)
})

test('a module miss inside a profile WITHOUT the child-exit marker is not claimed', () => {
  // The marker is what says the child died before it consumed its launch
  // request. Without it, a command or a tool that merely failed to import
  // something in a profile tree is a different story, and the two remedies this
  // plugin names would be a guess.
  const text = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis'\n  imported from ${PROFILE_MODULES}`
  assert.equal(classifyChildModuleFailure(text), undefined)
})

test('a relative or builtin specifier is not this defect', () => {
  const at = (specifier) => `worker-exit\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '${specifier}'\n  imported from ${PROFILE_MODULES}`
  assert.equal(classifyChildModuleFailure(at('./local.js')), undefined, 'a relative miss is a broken package, not a peer')
  assert.equal(classifyChildModuleFailure(at('node:fs')), undefined, 'a builtin cannot be a profile peer')
  assert.equal(classifyChildModuleFailure(at('/abs/path.js')), undefined)
})

test('a missing SUBPATH is a different defect and is not claimed', () => {
  // The package is present; an export is not. Linking a peer would not fix it.
  const text = `worker-exit\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis/lib/internals.js'\n  imported from ${PROFILE_MODULES}`
  assert.equal(classifyChildModuleFailure(text), undefined)
})

test('an importer outside a profile tree is somebody else job', () => {
  const text = "worker-exit\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis'\n  imported from /app/src/index.js"
  assert.equal(classifyChildModuleFailure(text), undefined)
})

test('a miss with no importer at all is not claimed', () => {
  // Without the importer there is no way to tell a profile tree from any other,
  // and the advice is only true of a profile tree.
  const text = "worker-exit\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis'"
  assert.equal(classifyChildModuleFailure(text), undefined)
})

test('the CommonJS require-stack rendering is NOT claimed', () => {
  // A deliberate boundary, recorded rather than blurred: the reported defect is
  // the ESM renderer, which prints the specifier and its importer on one
  // sentence. A `Require stack:` block is a different layout with the importer
  // on a separate line, and this plugin does not claim a format it has not seen
  // in the field — so the failure is left exactly as it is. (What that costs is
  // stated in the README: a CJS-only plugin missing a peer keeps the bare error.)
  const text = `worker-exit\nError: Cannot find module '@deepseek-ai/cordis'\n  Require stack: ${PROFILE_MODULES}`
  assert.equal(classifyChildModuleFailure(text), undefined)
})

test('a file: URL importer is decoded before it is judged', () => {
  const text = "worker-exit\n[ERR_MODULE_NOT_FOUND]: Cannot find package 'p'\n  imported from file:///home/.dsh/profiles/dev/node_modules/a/lib/index.js"
  assert.equal(classifyChildModuleFailure(text).importer, '/home/.dsh/profiles/dev/node_modules/a/lib/index.js')
})

test('a Windows importer path is recognized', () => {
  const text = "worker-exit\n[ERR_MODULE_NOT_FOUND]: Cannot find package 'p'\n  imported from C:\\Users\\me\\.dsh\\profiles\\dev\\node_modules\\a\\lib\\index.js"
  assert.equal(classifyChildModuleFailure(text).importer.startsWith('C:\\'), true)
})

test('barePackageName accepts a package root and nothing else', () => {
  assert.equal(barePackageName('@deepseek-ai/cordis'), '@deepseek-ai/cordis')
  assert.equal(barePackageName('left-pad'), 'left-pad')
  assert.equal(barePackageName('@deepseek-ai/cordis/lib/index.js'), undefined)
  assert.equal(barePackageName('@scope'), undefined)
  assert.equal(barePackageName('a/b'), undefined)
  assert.equal(barePackageName('a\\b'), undefined)
  assert.equal(barePackageName('node:fs'), undefined)
  assert.equal(barePackageName(''), undefined)
})

test('the first claimable specifier wins when a message names several', () => {
  const text = `worker-exit\n[ERR_MODULE_NOT_FOUND]: Cannot find package 'first-pkg'\n  imported from /x/src/a.js\n`
    + `[ERR_MODULE_NOT_FOUND]: Cannot find package 'second-pkg'\n  imported from ${PROFILE_MODULES}`
  assert.equal(classifyChildModuleFailure(text).packageName, 'second-pkg', 'the profile-shaped one is the claimable one')
})
