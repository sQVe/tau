# ADR 0007: Test placement, names, and fakes

**Date**: 2026-11-15\
**Status**: Accepted\
**Related**: [ADR 0006 (Side effects as records of functions)](./0006-side-effect-records.md)

## Context

Agents copy nearby files, so each unwritten test pattern spreads. When tests have no predictable
home, a reader cannot find the test for a module, and two agents write two tests for one behavior.

A test that fakes a module instead of its boundary breaks when the module's internals change, even
when its behavior does not. A test that reads a list of calls breaks when the call order changes.

## Decision

A test sits beside the code it owns and is named after that owner, every case lives in one decision
table, and tests fake only an I/O boundary.

### Placement and names

- In Rust, unit tests live in a `#[cfg(test)] mod tests` that the owning file declares. A split
  source file splits its tests with it.
- In TypeScript, a unit test sits beside its owner as `<owner>.test.ts` or `<owner><Behavior>.test.ts`.
- Tests that use several modules, or the program from the outside, live in `tests/`. Name them for
  their owner and behavior. In Rust, keep as few test targets as possible, because each file in
  `tests/` builds as its own binary.
- Tests that run real outside processes or sessions are integration tests. Mark them with the
  language's integration naming, such as `*.integration.test.ts`, so they can run apart.
- No test file is named after a campaign or a test technique, such as a mutation round or a fake.

### One home per behavior

- A decision table holds every case of one decision. In Rust, it is an array walked by a `for` loop
  with the case name in the assert message.
- An adapter test holds one case per outcome kind and its side effects.
- A shared module's behavior is tested once, in that module, not again through its callers.

### Fakes and assertions

- Fake the boundary, not the module: a child process, the file system, the clock, or an outside
  service. Pass fakes through the records of functions of
  [ADR 0006](./0006-side-effect-records.md).
- Do not fake pure code, and do not add a trait or interface only so a test can fake it.
- Assert outcomes. Read a list of calls only when the call is the behavior.
- When code must refuse, assert the error and that nothing else changed.
- Do not assert inside a fake whose errors the code may catch. Record the value and assert after the
  call.

### Fixtures and support files

- A fixture used by one module lives in that module's `fixtures/`. A fixture used by two modules or
  by `tests/` lives in `tests/`.
- Setup shared by two or more test files lives in one shared support module in `tests/`. Setup used
  by one test file stays in it.
- A test that touches the file system gets its folder from a temporary directory, never from a path
  built by hand.

## Consequences

### Positive

- A reader finds the test for a module beside it, and finds shared support in one place.
- A behavior change breaks the tests of one module instead of its callers.
- Shared fakes replace private copies of the same boundary.

### Negative

- Existing files that break a rule stay until cleanup work moves them.
- Faking only boundaries makes some tests set up more of the real module.

## Alternatives considered

### A nested `tests/` tree

Group support files in subfolders of `tests/` by feature. Rejected because suffixes in a flat folder
give the same grouping, and agents place files in a flat folder more reliably.

### Mock each module

Replace a module's collaborators with mocks. Rejected because the tests would pin internal calls
instead of behavior, and break on every refactor.

### No written rule

Keep the current practice and let reviewers correct files one by one. Rejected because agents copy
nearby files, so each unwritten pattern spreads.
