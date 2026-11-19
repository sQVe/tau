# Rust coding guide

Apply these rules with the [general coding guide](../../shared/coding.md) to every Rust file,
tests included. Where they differ, this guide wins. A general rule this guide does not change
applies as written.

## Names

These names are exceptions to the full-word naming rule.

- Keep a name that a standard or trait method requires, such as `fmt`.
- Use `T` for a generic type parameter and short names such as `'a` for lifetimes.

## Item order and modules

- Order items top-down: public and high-level items first, private helpers after the items that use
  them. This replaces the general rule to declare a helper before its caller.
- Follow [ADR 0003](../../shared/adr/0003-owner-folders-and-file-names.md) for module files and names.

## Errors

Follow [ADR 0005](../../shared/adr/0005-results-and-parse-once.md) for typed errors, app errors,
panics, and parsing.

- Propagate a `Result` with `?`.
- Derive typed errors with `thiserror`.
- Add context to app errors with `.context(...)` or `.with_context(...)`.
- Import the context trait as `use anyhow::Context as _;`.
- Use `expect` with a message that says why the call cannot fail, such as
  `.expect("a validated identifier parses")`.
- Never discard a `Result`. `let _ =`, `_ =`, `drop(result)`, and an unused `.ok()` all discard it.
  Propagate it, or handle the error in a `match` or `if let Err(error)`.
- In `Drop`, where no caller can take a cleanup error, print it with `eprintln!` inside
  `if let Err(error)`. Put `#[expect(clippy::print_stderr, reason = "...")]` on the `drop` method.

## Statements and expressions

- Write these forms inline: `?`, `if let`, `let ... else`, an `if` or `match` that produces a value,
  and a short iterator chain such as `names.iter().any(...)`. This replaces the general rules on
  call chains and ternary expressions.
- Name a chain with its own `let` when it is long, or when its result is a concept the reader should
  see by name, such as the rows a `for` loop walks.
- Use an `Option<T>` field for an optional value. The general spread rules do not apply to Rust.

## Function size

Follow [ADR 0009](../../shared/adr/0009-advisory-review-signals.md) for size review signals.
Do not split an exhaustive `match` only to meet them.

## Ownership

- Borrow a view to read: take `&str`, `&[T]`, and `&Path`, not `&String`, `&Vec<T>`, and `&PathBuf`.
- Take an owned value, such as `String`, `Vec<T>`, or `PathBuf`, when the function keeps it. Do not
  borrow and then clone inside.
- Clone on purpose. Before you write `.clone()`, check whether a move or a shorter borrow works.
- Suppress a lint with `#[expect(lint, reason = "...")]` on the smallest item that needs it. Use
  `#[allow(lint, reason = "...")]` only where the lint fires in some builds and not in others.

## Doc comments

- Write `///` doc comments only on items another crate uses.
- In a doc comment, state only errors, panics, and invariants the name and types cannot show.

## Tests

Follow [ADR 0007](../../shared/adr/0007-test-placement-and-fakes.md) for test placement, naming,
decision tables, and fakes. Follow [ADR 0006](../../shared/adr/0006-side-effect-records.md) for
side effects as records of functions.

- A test that touches the file system gets its folder from `tempfile`, never from a path built by
  hand. The `TempDir` guard must stay alive while the test uses its folder.
- Assert the error variant and its data with `assert!(matches!(...))` or `assert_eq!`, never only
  `is_err()`. Do not compare a human-readable message unless its exact text is a contract.
- Use `#[should_panic(expected = "...")]` only for code that panics on purpose.
- Follow [ADR 0009](../../shared/adr/0009-advisory-review-signals.md) for advisory mutation testing.
