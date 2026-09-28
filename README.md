# Tau

Tau adds tools, work steps, and checks to [Pi](https://github.com/badlogic/pi-mono).

Tau guides test-driven development, or TDD, with test results and nonblocking hints:

- write a failing test first
- prove the failure
- implement the minimum change
- prove the pass
- optionally refactor safely

A `tdd` block in `~/.pi/agent/tau.json` sets which files the hints cover and how Vitest runs. A
trusted repository's `.pi/tau.json` overrides it per field. `run_tests` output shows the effective
config.

Pi runs the agent and its tools. Tau stages and commits with installed Git hooks without a prompt.
Test results never control edit permission. Tau is not a general agent framework.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Tau is under active development. Expect bugs and changes to how it works.

- [Vision](./docs/vision.md)
- [Development](./docs/development.md)
- [Documentation](./docs/README.md)
