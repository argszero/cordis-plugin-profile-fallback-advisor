# @argszero/cordis-plugin-profile-fallback-advisor

Turns the silent aftermath of a retired fallback writer into a diagnosis with two
ways out.

A `dsh` profile that has plugins installed into it **still chats**, while every
child process it spawns dies before running anything. This plugin recognizes that
failure at the tool pipeline, says what happened where the model can read it, and
— only if you ask — links the missing peers back into the shared fallback
directory that 0.1.7 stopped maintaining.

- Source discussion: [deepseek-ai/deepseek-harness#7635](https://github.com/deepseek-ai/deepseek-harness/discussions/7635)
- This is a **community plugin**, not part of the harness: an independent npm
  package mounted by a `dsh` config patch.

## The failure

```
Error: code run failed (worker-exit): subprocess scope exited before its bootstrap consumed the launch request
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis'
    imported from <profile>/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js
```

Chat works, the model reasons, `run_code` and voice input fail. Retrying never
helps: the child exits before it runs anything, every time.

## Why

`dsh` installs out-of-tree plugins into a profile's own `node_modules` and asks
pnpm **not** to install peers (`autoInstallPeers: false` in the profile's
`pnpm-workspace.yaml`), because every plugin is meant to share the installation's
single `cordis` rather than carry a duplicate.

Through **0.1.6** the missing peers were served by a shared fallback directory the
boot package *maintained* on every start (`healProfilesModuleFallback` and
friends). From **0.1.7-rc.1** the writer is gone — the boot package computes a
runtime resolution and writes no module-resolution files at all — while the
setting that created the need is unchanged.

Inside the launching process the loss is invisible: it holds an in-memory
resolution table plus a loader interception, and worker threads get the resolution
through the worker bootstrap. **Subprocesses get neither.** `ctx.subprocess.spawn`
starts a bare `node`, the runner deletes every `NODE_*` / `TSX_*` variable before
launch (`subprocess-local/src/runner-launch.ts`), and the private runner protocol
carries only `cwd` / `env` / `control` — no resolution field. So the child
resolves the ordinary Node way, walks up `node_modules`, and dies on the first
peer only the installation has.

## Install

```sh
dsh plugin add --profile <profile> github:argszero/cordis-plugin-profile-fallback-advisor
```

The verb installs the package and records it in the profile's
`dsh.profile.bundles`, so it is mounted in one step. To mount it by hand instead,
add it to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: profile-fallback-advisor
      name: '@argszero/cordis-plugin-profile-fallback-advisor'
      config:
        repair: false
```

The package ships its own bundle patch (`dsh.bundle.patch`), so a launcher that
reads that field can mount it in one step. Both remedies need a **`dsh` restart**:
the resolution is built at boot.

## What it does

**1. A boot scan.** The same upward walk a child performs — the profile's own
`node_modules`, then `<home>/profiles/node_modules`, then `<home>/node_modules` —
run for every name the profile's locally installed packages require. The verdicts,
and the limits of the scan, go to the host log either way, so a quiet start and a
scan that never ran do not look alike.

**2. One advisory per agent.** On the first recognized child-process failure the
failing tool result is enriched with a durable user-role message naming the
package, the importer, what the walk found at each level, and the two options the
user owns. It rides `additionalContexts`, so the model reads it beside the failure
instead of only in a log it never sees. The message says plainly that retrying
cannot help and asks the model to stop and hand the choice over.

**3. An opt-in repair** (`repair: true`, default **off**). It links the
installation's own copies into `<home>/profiles/node_modules` — the cross-profile
fallback that 0.1.7 neither writes nor deletes, so nothing else is writing there.
The repair is **additive**:

- it creates and refreshes links, on every boot, so a later `dsh` upgrade cannot
  leave them dangling;
- the only entries it ever replaces are a **dangling symlink** (nothing is lost)
  or a directory that marks itself as a `dsh`-managed module proxy through its own
  manifest (`dsh.moduleFallback.targets`);
- anything else at a link path — a file, a real directory, a foreign package — is
  reported for a human and **never removed**;
- it never writes into the profile's own `node_modules` at all. That tree belongs
  to pnpm: a dead link there means the store generation was garbage collected, and
  the remedy is `pnpm install` in the profile, not a file written behind the
  package manager's back;
- it never links a name the installation does not have. A peer whose copy exists
  nowhere cannot be bridged by a link, so it is reported instead of approximated.

Both places it touches are the same phenomenon from opposite ends: machines that
ran 0.1.6 keep a directory full of dangling links (sub-case a — they are
refreshed), and machines that never did have no such directory at all (sub-case b
— it is created).

## Config

```yaml
- id: profile-fallback-advisor
  name: '@argszero/cordis-plugin-profile-fallback-advisor'
  config:
    repair: false          # false (default) = advisory only: nothing is ever written
    extraNames: []         # names to probe even when nothing local declares them
    include: []            # tool-name wildcards to watch; empty means every tool
    exclude: []            # tool-name wildcards never watched
    href: ''               # optional URL quoted at the end of the advisory
```

## The two remedies it hands the user

1. **Let pnpm install the peers into the profile.** Add `autoInstallPeers: true`
   to the profile's `pnpm-workspace.yaml`, run `pnpm install` in the profile
   directory, restart `dsh`. The plugin mounts are unaffected: the installation's
   names stay reserved for the launching process, so it keeps using its own single
   `cordis`.
2. **Mount this plugin with `repair: true`** and restart, so the shared peer
   fallback is filled in again.

What does **not** help: retrying the call, setting `NODE_PATH` (the subprocess
runner deletes it before launch), and proxy or routing changes (this is not a
network failure).

## Honest boundaries

- **The real fix is upstream**: restore the writer, or tell the child about the
  resolution. This plugin is the stopgap. It complements, and does not replace, a
  fix in the boot package.
- **It does not make a child resolve anything by environment.** Every candidate
  carrier was checked and is closed: the runner deletes `NODE_*` / `TSX_*`, and
  the runner protocol has no resolution field. The shared directory is the only
  cross-process carrier a third-party plugin can write.
- **It does not replace the subprocess service.** A contract-compatible subclass
  could inject a carrier, but a context admits one implementation per service —
  mounting it would displace the sandboxed local provider.
- **Only the top level of the profile's `node_modules` is inspected** — the
  hoisted linker's flattened shape, and the layer a child walks first. Transitive
  layouts a different linker could produce are outside the scan, and the report
  says so rather than implying full coverage.
- **Only Node's ESM rendering is claimed**: `Cannot find package '<pkg>' imported
  from <path>`. A CommonJS `Require stack:` block is a different layout and is left
  alone — the cost is that a CJS-only package missing a peer keeps the bare error.
  That is a silence, not a false claim.
- **The reactive half needs three facts** — the child-exit marker, Node's module
  error code, and an absolute importer path inside a profile tree. A test whose
  output merely quotes the two lines is not advised (the gate is the result's error
  state), and a missing *subpath* is refused on purpose: that is a different
  defect, and linking a peer would not fix it.
- **No privilege, no network, no config mutation.** It reads the filesystem, logs,
  attaches one message, and (only when asked) creates links in one directory.

## Compatibility

Built and tested against `@deepseek-ai/dsh-tools` / `dsh-llm` on the **0.1.7**
line (`0.1.7-rc.1`) and again on the **0.2.1** line (`0.2.1-rc.3`), and the peer range admits the lines the plugin was reasoned
about — `0.1.2-rc.1`, `0.1.3-alpha.2`, `0.1.5-alpha.1` (the last generation that
shipped a working writer), `0.1.6-alpha.1`, `0.1.7-alpha.1`, `0.1.7-rc.1`, `0.2.1-rc.3`:

```
^4.0.2                                                                    # @deepseek-ai/cordis
>=0.1.2-rc.1 <0.2.0 || >=0.1.3-alpha.2 <0.2.0 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-alpha.1 <0.2.0 || >=0.1.7-alpha.1 <0.2.0 || >=0.2.1-rc.1 <0.2.1   # @deepseek-ai/dsh-llm
>=0.1.2-rc.1 <0.2.0 || >=0.1.3-alpha.2 <0.2.0 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-alpha.1 <0.2.0 || >=0.1.7-alpha.1 <0.2.0 || >=0.2.1-rc.1 <0.2.1   # @deepseek-ai/dsh-tools
```

The defect itself is platform-neutral (it is a module-resolution and subprocess
question, not a Windows or macOS one), so the suite exercises it on a real tree
built in a temporary directory; what it does **not** witness is a real `dsh`
subprocess dying this way, because that needs an installation whose writer is
actually retired.

## Tests

```sh
pnpm install
pnpm test            # tsc, then node --test over test/*.spec.mjs
pnpm run test:inject # defect injection: mutate the source, require the suite to catch it
```

The suite mounts the plugin on a real cordis context and the real `dsh-tools`
`ToolRuntime`, drives calls through the real `tools/post-execute` waterfall, and
builds real profile trees — including both sub-cases of the retired writer (a
directory full of dangling links, and no directory at all).

## License

MIT
