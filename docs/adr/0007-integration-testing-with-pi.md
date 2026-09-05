# ADR 0007: Integration testing against a real pi session

- Status: Proposed
- Date: 2026-09-05

## Context

- Unit tests hand-roll `ExtensionAPI` stubs, so they prove handler logic but never prove that
  `pi.on`, `pi.registerTool`, and `pi.registerCommand` actually wire tau into pi.
- Tau's guarantees are runtime wiring guarantees: a blocked bash call, a confirmed commit, a phase
  gate. A stub that never runs pi's dispatcher cannot fail when the wiring breaks.
- `ctx.hasUI` and `ctx.ui.confirm` behave differently per pi mode, and the commit tool branches on
  both.
- CI must stay deterministic, offline, and free. Tests that call a model provider are none of these.

## Options considered

- **Keep hand-rolled `ExtensionAPI` stubs** — fast, but tests the stub, not pi. Wiring errors and
  schema rejections stay invisible until manual use.
- **Real `AgentSession` driven by pi's faux provider** — pi ships `registerFauxProvider`, which
  scripts assistant messages and tool calls through the real streaming path with no network.
- **Subprocess `pi -p` / `--mode json`** — exercises the real binary, but `hasUI` is hardwired false
  in print mode, so the commit happy path is unreachable and every run needs an API key.
- **Subprocess `pi --mode rpc`** — the only transport exposing the confirm round-trip over the wire,
  but it needs a real API key, and pi's shipped `RpcClient` neither handles `extension_ui_request`
  nor is reachable through the package `exports` map.

## Decision

Integration tests drive a real pi `AgentSession` with tau loaded through pi's own extension loader,
scripting the model with the faux provider from `@mariozechner/pi-ai`.

### Layers

- `*.test.ts` — unit tests for pure logic, colocated next to source.
- `*.integration.test.ts` — a real `AgentSession`, a real temp git repo, a scripted model. No
  network, no API key, runs in CI.
- Model-behavior checks (does the agent follow a skill) are evals, not tests. They are out of scope
  for CI.

### Isolation

Every integration test gets a temp `cwd` and a temp `agentDir`, plus `SessionManager.inMemory()`,
`SettingsManager.inMemory()`, `AuthStorage.inMemory()`, and `ModelRegistry.inMemory()`. Resource
discovery is disabled (`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`) so a developer's
`~/.pi` can never change a result.

### Pinning

`@mariozechner/pi-ai` is a devDependency pinned to the version pi-coding-agent resolves. The
provider registry is a module-level singleton, so two copies of pi-ai mean the session cannot find
the faux provider.

## Tradeoffs

- Wiring failures, tool schema rejections, and `hasUI` branches become testable.
- The faux provider is scripted in code, so scenarios stay readable and reviewable in the test.
- Tests stay offline, deterministic, and free, matching upstream pi's own testing policy.
- Cost: tau now depends on pi internals (`bindExtensions`, `DefaultResourceLoader`) that carry no
  stability guarantee, so a pi upgrade can break the harness rather than the product.
- Cost: a second pi-ai copy in the dependency graph breaks the harness with a confusing error.
- Cost: the confirm round-trip is proven in-process, not over pi's RPC wire protocol.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
