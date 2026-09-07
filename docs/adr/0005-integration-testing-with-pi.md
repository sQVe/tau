# ADR 0005: Integration testing against a real pi session

- Status: Proposed
- Date: 2026-09-05

## Context

- Unit tests use `ExtensionAPI` stubs to check handlers. They cannot prove that `pi.on`,
  `pi.registerTool`, and `pi.registerCommand` connect Tau to Pi correctly.
- Tau needs to check that Pi blocks a bash call or asks for commit approval. A test that replaces
  Pi's event handling with a stub cannot catch a broken connection.
- `ctx.hasUI` and `ctx.ui.confirm` behave differently per pi mode, and the commit tool branches on
  both.
- CI tests must give repeatable results without network access or model fees.

## Options considered

- Keep `ExtensionAPI` stubs. Fast, but cannot catch broken Pi setup or rejected tool inputs.
- Use a real `AgentSession` with Pi's faux provider. `fauxProvider` lets tests supply assistant
  messages and tool calls without a network connection.
- Run `pi -p` or `--mode json` in a subprocess. Uses the real program, but `hasUI` is always false
  in print mode. Tests cannot approve a commit, and each run needs an API key.
- Run `pi --mode rpc` in a subprocess. Tests could exchange approval messages, but this needs an API
  key. Pi's `RpcClient` does not handle `extension_ui_request` and is not in the package `exports`
  map.

## Decision

Integration tests use a real Pi `AgentSession`, load Tau through Pi's extension loader, and supply
model responses through the faux provider from `@earendil-works/pi-ai`.

### Layers

- `*.test.ts` for unit tests of pure logic, next to the code they test.
- `*.integration.test.ts` for tests with a real `AgentSession`, a temporary Git repository, and
  scripted model responses. Run in CI without a network connection or API key.
- Check whether the model follows a skill through separate evaluations outside CI.

### Isolation

Every integration test gets a temp `cwd` and a temp `agentDir`, plus `SessionManager.inMemory()`,
`SettingsManager.inMemory()`, and a `ModelRuntime` with in-memory credential and model stores. Model
configuration loading and initial catalog refresh are disabled. Resource discovery is disabled
(`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`) so a developer's `~/.pi` can never
change a result.

### Dependency versions

`@earendil-works/pi-ai` is a devDependency with the same version range as pi-coding-agent, so both
resolve to a single copy. Register the faux provider on the session's `ModelRuntime` so both the
agent and comment reviewer use the same scripted responses.

## Tradeoffs

- Tests can catch broken Pi setup, rejected tool inputs, and errors in `hasUI` branches.
- The faux provider is scripted in code, so scenarios stay readable and reviewable in the test.
- Tests give repeatable results without network access or model fees, matching Pi's testing rules.
- Cost: tests depend on Pi internals such as `bindExtensions` and `DefaultResourceLoader`. A Pi
  upgrade can break the test setup even if Tau still works.
- Cost: approval messages are tested within one process. Pi's RPC connection remains untested.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
