# ADR 0146: Load one generated Tau bundle that matches the package inputs

**Date**: 2026-11-20\
**Status**: Accepted\
**Related**: [ADR 0003 (Stability of externally observable identifiers)](./0003-externally-observable-identifiers.md),
[ADR 0005 (Integration testing against a real Pi session)](./0005-integration-testing-with-pi.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

Pi loads Tau through jiti, which transforms and resolves every module of the package at startup. One
load of the Tau extension spends several seconds of one CPU there, and every Pi process that loads
Tau pays it: a manager start, each worker, and each test that opens a real session. The cost grows
with the number of source files and with CPU contention, so a worker that starts under load spends
most of its wait before its first turn.

Pi resolves an extension's bare imports through its own aliases and virtual modules, so Tau cannot
bypass Pi's resolver. Pi also discovers the extension by the path in `package.json`, and users and
saved sessions depend on the names Tau registers.

## Decision

`src/tau.ts` stays the one extension entry that `package.json` names, and it loads one generated
bundle when that bundle matches the current package inputs. Otherwise it loads the source
registration.

### The entry and the registration

`src/tau.ts` reads the input key and imports `dist/tau/<key>.mts` through a dynamic import, so Pi's
resolver still supplies the Pi modules. The registration sequence moves unchanged to
`src/tau/tau.ts`, which the entry loads when no artifact matches. An artifact that matches and then
fails to import or initialize reports that error; the entry never registers a partial set and never
retries the source registration. A missing artifact is not an error, because a checkout with live
edits and an install that skipped scripts both have none.

### The input key

The key is a SHA-256 over the sorted package-relative names and content hashes of every regular file
under `src/` with a `.ts`, `.mts`, `.js`, `.mjs`, or `.json` suffix, plus `package.json`,
`tsconfig.json`, the build script, and every file the `extends` chain of `tsconfig.json` reaches.
Content, not a timestamp, decides the key, because two edits can share a size and a timestamp can
repeat. The key refuses a layout whose bytes it cannot cover, each with its own message: a symlink
anywhere under `src/`, including `src/` itself, because retargeting it changes the bundle without
changing the key; a directory under `src/` that holds its own `package.json`, because Rolldown
resolves requests through that manifest; and a `tsconfig.json` below the package root, because
Rolldown can select a nearer config whose `extends` base is not keyed. The same refusal covers a
`package.json` in any directory between a keyed file outside `src/`, such as the build script or an
inherited config, and the package root, because Rolldown reads that manifest's `sideEffects`; the
root `package.json` stays keyed. The key reads a TypeScript config that holds comments, trailing
commas, and a leading byte order mark. It refuses a chain that names a package, leaves the package
by resolved path, or reaches a config whose real path leaves the package, so a config symlink cannot
key a file outside it. The key returns its full inventory: the keyed `src/` files, `package.json`,
`tsconfig.json`, the build script, and the root `tsconfig.json` extends chain. The loader selects
the exact key only, and reading the key never starts Git, runs a build, or reads user configuration.

### The build

`scripts/buildTauExtension.ts` bundles `src/tau/tau.ts` with Rolldown and the TypeScript parser from
`@voidzero-dev/vite-plus-core`. It keeps bare imports and Node built-ins external and rebases each
source `import.meta.url` to the URL of the original module, so skills, instruction files, profiles,
and worker entry files keep their source paths. It rejects an `import.meta` form it cannot rebase
and an asset URL that does not exist beside its module. It never resolves a request through a
manifest entry point, so a nested `package.json` cannot redirect a directory import into code the
key leaves out, and a directory import that relied on one fails instead. It skips URL rebasing for a
JSON module, which is data and holds no `import.meta`. It emits one chunk, so a literal dynamic
import of a keyed module stays in the artifact and stays deferred. The key owner returns its full
inventory from the same scan that computes the key. The build checks every resolved module against
that inventory, so a module outside it is refused, while the keyed root manifest and an inherited
config may be imported as JSON modules. The check reads the resolved module, so an extensionless or
directory import is judged by the file it resolves to. The build walks no ancestors and resolves
nothing through a manifest; the key refuses a nested manifest before a build runs. After generating,
the build also checks every path Rolldown reports in `bundle.watchFiles` against the same inventory
and fails, naming the file, before it accepts or writes any output. That check covers a file the
bundle reads without keeping it in the chunk, such as a config reached through a TypeScript project
reference or a re-export that tree shaking removes. The resolver does not follow symlinks, so a
module keeps the path the source names and a link path outside the inventory is refused rather than
read through. `watchFiles` is experimental in the pinned Rolldown version, so the tests cover each
input class the build relies on. The build always bundles, so these refusals cover a tree that
already has an artifact at the key; a complete artifact for the exact key is not rewritten. It
writes the complete chunk to a unique sibling file, rechecks the key, and renames it into place; a
failed build, a changed key, or a missing input publishes nothing. Generated files are ignored and
not committed.

`pnpm build:tau` runs the build, `prepare` runs it before the existing hook setup, and `pnpm check`
runs it before the test stage. The builder is a production dependency, so Pi's Git install builds
without devDependencies or Pi peer packages.

## Consequences

### Positive

- One Pi load of Tau resolves one generated file instead of the whole source graph, in every process
  that loads Tau.
- A Git install, a worker start, and a full check all load the same artifact without a runtime
  build.
- An edited source tree cannot load a stale artifact, because the key covers the content.

### Negative

- A checkout needs one build step before it loads the fast path, and a source edit falls back to the
  slow path until the next build.
- A source module must use one of the keyed suffixes, so a CommonJS file cannot join the bundle
  without a key change.
- A directory import must name a file or an `index` file, because no manifest entry point resolves
  one.
- The build is a second place that reads Tau's module graph, so a new bundling rule can break it.
- Reading the key hashes every source file on each load.

## Alternatives considered

### Native `.js` or `.mjs` output

Fewer evaluation steps in a development probe, because Node imports the file directly. Rejected
because a native import cannot use Pi's aliases or virtual modules; without local peers it fails,
and with them it can load a second copy of the Pi API under a different identity.

### Commit `dist`

No assembler at install time. Rejected because generated code would change on every source edit and
would add a second tracked copy that can be stale.

### Lazy tool handlers or a split extension entry

No build step. Rejected because lazy handlers move the load into tool calls and depend on new
ordering and state boundaries, and a second discovered entry changes Pi's load order and the
manifest that users install.
