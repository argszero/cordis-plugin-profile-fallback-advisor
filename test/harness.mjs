/**
 * The integration harness both behavior suites mount the plugin on: a REAL
 * cordis context, the REAL `dsh-tools` ToolRuntime, registrable fixtures, and
 * the real `tools/post-execute` waterfall — plus helpers that build a real
 * profile tree on disk, because this plugin's subject is what Node's upward walk
 * finds there.
 *
 * What this shape proves that a unit arm cannot: the listener is wired to the
 * seam, the advisory really rides `additionalContexts` on the settled result
 * (the channel the agent loop turns into a durable user-role message), and the
 * boot scan and the opt-in repair act on a real filesystem.
 *
 * What it cannot prove, and does not claim: that the harness's own 0.1.7 boot
 * package retired the writer, or that a real `dsh` subprocess dies this way. The
 * mode (`autoInstallPeers: false`) is written into the fixture, and the failure
 * text is taken from the report (#7635) — that text is the plugin's entire input
 * on every platform.
 *
 * The profile facts are provided from a fiber, exactly as the launcher provides
 * them (`hostCtx.provide('profileContext', …)`), so the plugin reaches them
 * through the optional `get` lookup it actually uses in production.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

/**
 * The failure #7635 reports, verbatim: the seam's wrapper, then the child's own
 * Node error with its importer path.
 * @param importer - the importer Node printed.
 * @param packageName - the specifier that could not be found.
 * @returns the two-line failure text.
 */
export function reportedText(
  importer = '/home/.dsh/profiles/dev/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js',
  packageName = '@deepseek-ai/cordis',
) {
  return 'code run failed (worker-exit): subprocess scope exited before its bootstrap consumed the launch request\n'
    + `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${packageName}'\n`
    + `    imported from ${importer}`
}

/** How many tool bodies actually ran, per fixture name. */
const ran = new Map()

/** A body counter that survives a fixture being called through the pipeline. */
export function count(toolName) {
  ran.set(toolName, (ran.get(toolName) ?? 0) + 1)
}

/** How many times one fixture's body ran since the last `world()`. */
export function runs(toolName) {
  return ran.get(toolName) ?? 0
}

/** One registrable tool whose body returns a value. */
export function okTool(toolName, value) {
  return {
    name: toolName,
    description: 'integration fixture',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, settled) => [{ type: 'text', text: settled }] },
    execute: () => {
      count(toolName)
      return Promise.resolve(value)
    },
  }
}

/** One registrable tool whose body always throws `message`. */
export function failingTool(toolName, message) {
  return {
    name: toolName,
    description: 'always-failing integration fixture',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, settled) => [{ type: 'text', text: settled }] },
    execute: () => {
      count(toolName)
      return Promise.reject(new Error(message))
    },
  }
}

/** A fresh abort signal per call, as the tool pipeline expects. */
export const signal = () => new AbortController().signal

/** One agent identity, memoized per id: the plugin keys its state on the object. */
const agents = new Map()
export function who(id) {
  if (!agents.has(id)) agents.set(id, { id, session: { id } })
  return agents.get(id)
}

// --- profile trees on disk -------------------------------------------------

/** A fresh OS-temp root for one test's profile tree. */
export function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'pfa-'))
}

/** Write a JSON file, creating its directory. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Install one package, and return its directory.
 * @param modulesDir - the `node_modules` directory to install into.
 * @param name - the bare package name (scoped names allowed).
 * @param manifest - the manifest to write (`name`/`version` included by the caller).
 * @returns the package directory.
 */
export function install(modulesDir, name, manifest) {
  const dir = join(modulesDir, name)
  writeJson(join(dir, 'package.json'), manifest)
  return dir
}

/**
 * Build one whole scenario: the harness home, the profile, and the installation.
 *
 * The shape mirrors the reported case — a profile whose own `node_modules` holds
 * one out-of-tree package that declares a peer only the installation has, with
 * `autoInstallPeers: false` in the profile's pnpm settings.
 * @param options - the knobs each test turns.
 * @returns the paths, ready to scan or mount.
 */
export function scenario(options = {}) {
  const root = tempRoot()
  const home = join(root, 'dsh')
  const profileDir = join(home, 'profiles', options.profile ?? 'dev')
  const installDir = join(root, 'app')
  const sharedModulesDir = join(home, 'profiles', 'node_modules')

  writeJson(join(installDir, 'package.json'), { name: '@deepseek-ai/dsh-cli', version: '0.1.7-rc.1' })
  install(join(profileDir, 'node_modules'), '@deepseek-ai/dsh-subprocess', {
    name: '@deepseek-ai/dsh-subprocess',
    version: '0.1.7-rc.1',
    peerDependencies: options.declares ?? { '@deepseek-ai/cordis': '^4.0.2' },
    ...options.extra ?? {},
  })
  if (options.sharedDir !== false) mkdirSync(sharedModulesDir, { recursive: true })
  if (options.installation !== false) {
    install(join(installDir, 'node_modules'), '@deepseek-ai/cordis', {
      name: '@deepseek-ai/cordis',
      version: '4.0.2',
    })
  }
  if (options.resolved === true) {
    // A tree where the walk is satisfied: the peer is loadable at one of the
    // levels a child visits, so the scan has nothing to report.
    mkdirSync(sharedModulesDir, { recursive: true })
    install(sharedModulesDir, '@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', version: '4.0.2' })
  }
  if (options.dangling !== undefined) {
    mkdirSync(sharedModulesDir, { recursive: true })
    for (const name of options.dangling) {
      const link = join(sharedModulesDir, name)
      // A scoped name needs its scope directory first.
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(join(root, 'gone', name), link)
    }
  }
  if (options.autoInstallPeers !== undefined) {
    writeFileSync(
      join(profileDir, 'pnpm-workspace.yaml'),
      `packages:\n  - .\nautoInstallPeers: ${String(options.autoInstallPeers)}\n`,
    )
  }
  return {
    root,
    home,
    profileDir,
    installDir,
    sharedModulesDir,
    /** The facts the launcher would provide. */
    facts: { dir: profileDir, home, installAnchor: join(installDir, 'package.json') },
  }
}

/**
 * Mount the real registry, the optional profile facts, and this plugin.
 * @param config - plugin config to forward; omitted → defaults.
 * @param fixtures - tool definitions to register after the plugin is mounted.
 * @param options - `profile` mounts a `profileContext` service; omit to leave it
 * unmounted, which is its own arm (a composition with no launcher).
 * @returns the context and the captured log messages.
 */
export async function world(config, fixtures = [], options = {}) {
  ran.clear()
  const ctx = new Context()
  const logged = []
  // `levels.default` is the highest level an exporter admits (2 = WARN), so
  // INFO lines reach the capture too — the boot report is the quiet case.
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })
  await ctx.plugin(systemPromptPlugin, {})
  await ctx.plugin(toolsPlugin)
  if (options.profile !== undefined) {
    // Provided from a fiber, so the service's lifetime is the test's and the
    // lookup under test is genuinely the optional `get` path.
    await ctx.plugin({ name: 'profile-facts-stand-in', apply: c => { c.provide('profileContext', options.profile) } })
  }
  await ctx.plugin({ name: plugin.name, apply: c => { plugin.apply(c, config ?? {}) } })
  for (const fixture of fixtures) ctx.tools.register(fixture)
  return { ctx, logged }
}

/** Drive one call through the real pipeline. */
export function call(ctx, toolName, args = {}, agent = who('s1')) {
  return ctx.tools.execute({ name: toolName, arguments: args, signal: signal(), agent })
}

/** The contexts one settled result carries. */
export function contexts(result) {
  return result.additionalContexts ?? []
}

/** One settled result's text. */
export function text(result) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** The body text of the single context riding a result. */
export function noticeText(result) {
  const [first] = contexts(result)
  return first.content.map(block => block.text).join('\n')
}

/**
 * The captured log as one string.
 *
 * A message carries the format string plus its arguments, unformatted — the
 * exporter renders them — so the arguments are joined in too.
 */
export function logText(logged) {
  return logged.map(message => message.args.map(value => String(value)).join(' ')).join('\n')
}

/**
 * The captured log lines that mention one phrase.
 * @param logged - the array `world()` returned.
 * @param needle - the substring a line must contain.
 * @returns the matching lines, in order.
 */
export function logLines(logged, needle) {
  return logText(logged).split('\n').filter(line => line.includes(needle))
}
