# Foundation: Vision

- Status: Active

## The idea

Tau aims to enforce a repeatable development workflow on top of Pi. Pi runs the agent and its tools;
Tau controls when work can advance. Each phase requires evidence before the next begins. For TDD,
that means observing a failing test before implementation and a passing test afterward.

This is the intended direction. See [development](../guides/development.md#current-status) for what
works today.

## Principles

- **Workflow over suggestion.** Enforce method, do not merely recommend it.
- **Evidence over intention.** Advancement requires proof, not a claim that the right thing
  happened.
- **Few concepts, strong enforcement.** Prefer a small set of concepts with clear meaning and hard
  boundaries.
- **Consistency over flexibility.** Optimize for repeatable, reliable behavior.

## In scope

- workflow phases.
- phase gates.
- required artifacts.
- verification rules.
- methodology enforcement.

## Out of scope

- models.
- tools.
- tool calling.
- agent runtime primitives.
- TUI and SDK capabilities.

## See also

- [Development and current status](../guides/development.md#current-status)
- [Documentation index](../README.md)
