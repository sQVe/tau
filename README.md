# Tau

Tau adds tools, work steps, and checks to [Pi](https://github.com/badlogic/pi-mono).

Tau guides test-driven development, or TDD, with test results and nonblocking hints:

- write a failing test first
- prove the failure
- implement the minimum change
- prove the pass
- optionally refactor safely

To set which files the hints cover, add a `tdd` block to `.pi/tau.json` in the repository, or to
`~/.pi/agent/tau.json` for every repository:

```json
{ "tdd": { "productionGlobs": ["{src,scripts}/**/*.ts"] } }
```

The block accepts `productionGlobs`, `testGlobs`, `testSupportGlobs`, `excludedGlobs`, and
`verificationArgv`. Each key you set replaces its default. The repository file overrides the user
file, and Tau reads it only in a trusted project. `run_tests` output shows the config in use.

To limit the models Tau picks for workers and `bulk_read`, add `allowedModels` to either file:

```json
{ "allowedModels": ["openai-codex/gpt-5.6-luna", "claude-bridge/claude-opus-5-5"] }
```

The repository list can only remove models from your list. Tau refuses any other model instead of
falling back.

Tau suggests `/compact` once the context of a manager session passes 200,000 tokens. It never
compacts by itself. To change the threshold, add `compaction` to either file:

```json
{ "compaction": { "reminderTokens": 150000 } }
```

Tau names no model of its own. Set the models for workers and `bulk_read` in `~/.pi/agent/tau.json`.
A worker launch needs a model passed on the launch, `profiles.<name>.model` for its profile, or
`profiles.default.model`, which covers every profile without its own entry. `bulk_read` needs
`bulkRead.model`:

```json
{
  "profiles": {
    "default": { "model": "claude-bridge/claude-opus-5-5" },
    "scout": { "model": "openai-codex/gpt-6.1-sol" }
  },
  "bulkRead": { "model": "openai-codex/gpt-5.6-luna" }
}
```

The `start-slice` skill creates agent tickets in the Linear team that `slice.agentTeam` names in
`~/.pi/agent/tau.json`:

```json
{ "slice": { "agentTeam": "AI" } }
```

Web answers use pi-web-access's own `fetch.answerProvider` and `fetch.answerModel` in
`web-search.json`.

Pi runs the agent and its tools. Tau stages and commits with installed Git hooks without a prompt.
Test results never control edit permission. Tau is not a general agent framework.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Tau is under active development. Expect bugs and changes to how it works.

- [Vision](./docs/vision.md)
- [Development](./docs/development.md)
- [Documentation](./docs/README.md)
