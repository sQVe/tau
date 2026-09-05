# Tau

Tau is an opinionated workflow governor for [pi](https://github.com/badlogic/pi-mono).

Pi was not enough. We wanted stronger defaults, stricter flow enforcement, and a more consistent way
of working.

Tau's first goal is to enforce strict TDD cleanly and reliably.

- write a failing test first
- prove the failure
- implement the minimum change
- prove the pass
- optionally refactor safely

Tau is not a general agent framework. Pi provides the runtime; Tau provides the workflow.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Tau is under active development. Expect churn, rough edges, and changing interfaces while the core ideas take shape.

- [Vision](./docs/foundations/vision.md)
- [Development and current status](./docs/guides/development.md)
- [Documentation](./docs/README.md)
