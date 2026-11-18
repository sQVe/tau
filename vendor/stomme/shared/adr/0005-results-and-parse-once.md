# ADR 0005: Typed results, panics for bugs, and parsing once

**Date**: 2026-11-15\
**Status**: Accepted

## Context

Agents and scripts call project tools many times at once, and each call must fail in a way the caller
can read. A hand-edited file can be broken, and the tool must keep running when it is.

Data enters from files, config, command output, and outside services. None of it can be trusted until
it is parsed. When each function checks the raw data it receives, the checks repeat, and one caller
misses one.

Rust and TypeScript report failures in different ways. Rust has `Result` and panics. TypeScript has
throws and unions. A shared rule must state what both languages share and leave each language its
normal tools.

## Decision

An outcome a caller branches on is a typed result, a bug panics or throws, and untrusted data is
parsed once at the boundary. Each language keeps its own way for failures that no caller tells
apart.

### Outcomes a caller branches on

- In Rust, such a function returns `Result` with an error enum that names each reason. Put the data a
  caller needs in fields, not only in the message.
- In TypeScript, such a function returns a discriminated union of its outcomes.
- A test that tells failures apart counts as a caller that branches.

### Failures no caller tells apart

- Rust app code returns `anyhow::Result` and adds context to each error. App code is the entry point
  and the code that only passes errors up to it.
- TypeScript throws for invalid input and failed operations. Add an `Error` subclass only when
  production code catches that exact condition.
- Turn an error into user text once, at the boundary that shows it.

### Bugs

- A bug panics in Rust and throws in TypeScript, where it happens.
- Checks for impossible states run in every build. Never use them to check input.
- Library code does not panic on input.

### Parse once

- Parse untrusted data once, where it enters, then check its meaning there. Pass trusted types
  inward, so code inside the boundary needs no defensive checks.
- Give an identifier its own type with one constructor that validates it, so a value of the type is
  always valid.

## Consequences

### Positive

- A caller sees each outcome it must handle in the return type.
- A bug fails where it happens, in every build.
- Code inside a boundary trusts its types.
- Neither language gives up its normal error style.

### Negative

- Results add code at every call that can fail.
- Checks that run in release builds must stay cheap.
- The two languages differ for failures no caller tells apart, so a reader must know both rules.

## Alternatives considered

### Panics or throws for every failure

Use panics or throws for every failure. Rejected because callers cannot see from a signature which
outcomes to expect, and a panic stops the whole process.

### Typed results for every failure, bugs included

Use typed results everywhere, bugs included. Rejected because impossible states would spread checks
through every caller, and a bug would read like an expected outcome.

### A generic result type in TypeScript

Add a shared `Result` type to TypeScript code and migrate to it. Rejected because a discriminated
union already names each outcome, and a migration would touch working code for no caller's gain.

### Assertions only in debug builds

Use assertions that run only in debug builds. Rejected because a broken state in a release build
would go on silently and fail later, far from its cause.

### Each caller parses its own input

Let each function check the raw data it receives. Rejected because each caller would repeat the
checks, and one caller would miss one.
