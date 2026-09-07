# Tau

Tau adds required work steps and checks to [Pi](https://github.com/badlogic/pi-mono).

We wanted a consistent way to work, with proof that each step is complete. Tau's first goal is to
enforce test-driven development, or TDD:

- write a failing test first
- prove the failure
- implement the minimum change
- prove the pass
- optionally refactor safely

Pi runs the agent and its tools. Tau controls the steps the agent must follow. Tau is not a general
agent framework.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Tau is under active development. Expect bugs and changes to how it works.

- [Vision](./docs/foundations/vision.md)
- [Development and current status](./docs/guides/development.md)
- [Documentation](./docs/README.md)
