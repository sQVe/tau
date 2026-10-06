# ADR 0005: Integration testing against a real Pi session

**Date**: 2026-09-05\
**Status**: Accepted\
**Related**: [ADR 0001 (Application structure)](./0001-application-structure.md)

## Context

Unit tests use `ExtensionAPI` stubs to check handlers. They cannot prove that `pi.on`,
`pi.registerTool`, and `pi.registerCommand` connect Tau to Pi correctly.

Tau needs to check that Pi blocks a bash call or asks for commit approval. A test that replaces Pi's
event handling with a stub cannot catch a broken connection.

`ctx.hasUI` and `ctx.ui.confirm` behave differently per Pi mode, and the commit tool branches on
both.

CI tests must give repeatable results without network access or model fees.

## Decision

Integration tests use a real Pi `AgentSession`, load Tau through Pi's extension loader, and supply
model responses through the faux provider from `@earendil-works/pi-ai`. `fauxProvider` lets tests
supply assistant messages and tool calls without a network connection.

### Layers

- `*.test.ts` for unit tests next to the code they test, or under `tests/` for cross-module checks.
  They may use a temporary Git repository but never a Pi session.
- `*.integration.test.ts` for tests with a real `AgentSession` or herdr, and scripted model
  responses. Run in CI without a network connection or API key.
- Check whether the model follows a skill through separate evaluations outside CI.

### Isolation

Every integration test gets a temporary `cwd` and `agentDir`, plus `SessionManager.inMemory()`,
`SettingsManager.inMemory()`, and a `ModelRuntime` with in-memory credential and model stores. Model
configuration loading and initial catalog refresh are disabled. Resource discovery is disabled
(`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`) so a developer's `~/.pi` can never
change a result.

### Dependency versions

`@earendil-works/pi-ai` is a devDependency with the same version range as pi-coding-agent, so both
resolve to a single copy. Register the faux provider on the session's `ModelRuntime` so the agent
and any delegate calls use the same scripted responses.

## Consequences

### Positive

- Tests can catch broken Pi setup, rejected tool inputs, and errors in `hasUI` branches.
- The faux provider is scripted in code, so scenarios stay readable and reviewable in the test.
- Tests give repeatable results without network access or model fees, matching Pi's testing rules.

### Negative

- Tests depend on Pi internals such as `bindExtensions` and `DefaultResourceLoader`. A Pi upgrade
  can break the test setup even if Tau still works.
- Approval messages are tested within one process. Pi's RPC connection remains untested.

## Alternatives considered

### `ExtensionAPI` stubs

Keep `ExtensionAPI` stubs. Rejected because, although they are fast, they cannot catch broken Pi
setup or rejected tool inputs.

### `pi -p` or `--mode json` in a subprocess

Run `pi -p` or `--mode json` in a subprocess. Rejected because, although it uses the real program,
`hasUI` is always false in print mode. Tests cannot approve a commit, and each run needs an API key.

### `pi --mode rpc` in a subprocess

Run `pi --mode rpc` in a subprocess. Rejected because, although tests could exchange approval
messages, this needs an API key. Pi's `RpcClient` does not handle `extension_ui_request` and is not
in the package `exports` map.
