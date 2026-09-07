# Foundation: Vision

- Status: Active

## The idea

Tau aims to enforce a consistent development process. Pi runs the agent and its tools. Tau checks
that each phase has the required evidence before the next begins. For test-driven development, that
means seeing a test fail before writing the code and pass afterward.

This is the goal. See [development](../guides/development.md#current-status) for what works today.

## Principles

- Require the agent to follow the work process.
- Require proof that a phase is complete before moving on.
- Use few concepts, with clear meanings and firm rules.
- Prefer a process that works the same way each time over one with more options.

## In scope

- workflow phases.
- checks before moving to the next phase.
- required outputs.
- verification rules.
- enforcing the work process.

## Out of scope

- models.
- tools.
- tool calling.
- the code that runs the agent.
- terminal interface and SDK features.

## See also

- [Development and current status](../guides/development.md#current-status)
- [Documentation index](../README.md)
