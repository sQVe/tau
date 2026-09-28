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

Pi runs the agent and its tools. Tau stages and commits with installed Git hooks without a prompt.
Test results never control edit permission. Tau is not a general agent framework.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Tau is under active development. Expect bugs and changes to how it works.

- [Vision](./docs/vision.md)
- [Development](./docs/development.md)
- [Documentation](./docs/README.md)
