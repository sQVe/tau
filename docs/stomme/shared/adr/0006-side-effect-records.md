# ADR 0006: Side effects as records of functions

**Date**: 2026-11-15\
**Status**: Accepted\
**Related**: [ADR 0007 (Test placement, names, and fakes)](./0007-test-placement-and-fakes.md)

## Context

Projects run outside tools, read and write files, take locks, and read the clock. Tests must run
without a network, an account, or a second machine.

A test of a refused action must show that no command ran and no file changed.

An adapter trait or interface with one implementation adds a type and no choice. A broad container of
effects lets every module reach every effect.

## Decision

Side effects reach a module as a narrow record of functions that the module declares for itself.
Each consumer names only the effects it uses, and tests pass fakes for those.

### Function records

- Each consumer declares its record beside its own code. In Rust, the record is a struct of
  functions. In TypeScript, it is an object type of functions.
- An action that needs a lock, a file write, and the clock declares a record with those three
  functions and nothing else.
- The entry point builds the production functions. Tests pass fakes and a fake clock.
- Do not use service containers, or traits and interfaces with one implementation.
- A long-running effect accepts a cancellation signal that its owner sets.

### Outside tools

Outside tools run as argument lists, never through a shell string. A shell string mixes data with
syntax, so an argument can change the command.

## Consequences

### Positive

- A function signature shows which effects a module can reach.
- Tests pass only the fakes a module uses, and record calls to assert after the action.

### Negative

- Two consumers of the same effect declare similar records.
- The entry point wires every record by hand.

## Alternatives considered

### Adapter traits and a service container

Use adapter traits or interfaces, or a container that holds every service. Rejected because each has
one production implementation, so the extra type adds no choice.

### One shared effects record

Use one record of effects for the whole app. Rejected because every consumer could reach every
effect, and one type would couple all modules.

### Direct calls with mocking libraries

Make direct calls inside each module, and replace them in tests with a mocking library. Rejected
because tests would depend on global state, and pure modules would gain I/O.
