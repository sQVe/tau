# Vision

Tau is a strict workflow layer on top of pi.

Pi provides the agent runtime, tools, and execution substrate. Tau provides the process.

## Core idea

Tau should enforce a specific way of working instead of merely suggesting one.

That means:

- work happens in explicit phases
- each phase has required outputs
- advancement requires evidence
- completion requires verification

## Initial focus

Tau starts with one hard problem: strict TDD.

The first useful version of Tau should robustly enforce:

1. write or update a test first
2. run the test and observe failure
3. only then allow implementation work
4. run the test again and observe success
5. optionally refactor while keeping tests green

## Boundary with Pi

Pi is the engine. Tau is the governor.

Pi owns:

- models
- tools
- tool calling
- agent runtime primitives
- TUI / SDK capabilities

Tau owns:

- workflow phases
- phase gates
- required artifacts
- verification rules
- methodology enforcement

## Design principles

- flow-driven, not command-zoo-driven
- strict by default
- few concepts, strongly enforced
- evidence over intention
- consistency over flexibility

## Likely core concepts

- Flow
- Phase
- Gate
- Artifact
- Method

## Near-term direction

Build Tau around a TDD state machine:

- Red
- Green
- Refactor

Tau should use pi’s structure to enforce this cleanly, rather than relying on brittle prompt-only
nudges or ad hoc hooks.
