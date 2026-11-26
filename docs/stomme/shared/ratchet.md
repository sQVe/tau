# Weakened-test ratchet

`stomme check` compares the working tree with the target branch and reports a test that a change
weakens. Each problem names the file and the line and carries the rule `weakened-test`. The lasting
reasons are in [ADR 0011](./adr/0011-weakened-test-ratchet.md).

## What the check reports

The check reports three forms of a weakened test.

- An added test skip.
- An added lint or type-check suppression.
- A deleted test case.

The check compares the trimmed text of each added line with a marker by prefix. A marker must start
the line. Text that merely contains a marker is not reported.

The check reads Rust and TypeScript source files: `.rs`, `.ts`, and `.tsx`, but not `.d.ts`. It
skips any path with a hidden folder or a `target`, `node_modules`, `vendor`, `dist`, or `fixtures`
folder. It compares the project folder, with paths relative to it, so a project inside a larger
repository compares only its own files.

| Form | Rust markers | TypeScript markers |
| --- | --- | --- |
| Test skip | `#[ignore]`, `#[ignore =` | `it.skip(`, `test.skip(`, `describe.skip(`, `suite.skip(`, `xit(`, `xtest(`, `xdescribe(` |
| Suppression | `#[allow(`, `#[expect(`, `#![allow(`, `#![expect(` | `// eslint-disable`, `/* eslint-disable`, `// oxlint-disable`, `/* oxlint-disable`, `// @ts-ignore`, `// @ts-expect-error`, `// @ts-nocheck` |

A skip produces ``line {line}: adds the test skip `{marker}`; keep the test running``. A
suppression produces ``line {line}: adds the suppression `{marker}`; fix the finding instead of
hiding it``.

## How a case is identified

A test case has a name. The check identifies a case by its file and its name.

A Rust case is a `fn` line whose preceding attribute names a test framework: `test`, `rstest`,
`test_case`, `quickcheck`, or `proptest`. The attribute path may hold the framework after `::`, as
in `#[tokio::test]`.

A TypeScript case is a line that starts with `it(`, `test(`, `it.skip(`, `test.skip(`, `it.only(`,
`test.only(`, `xit(`, or `xtest(`. The name is the quoted first argument after the first `(`, and a
backslash escapes the next character. A computed first argument is not a declaration.

A base case is deleted when no current case has the same file and name, unless a case with that
name was added elsewhere in the change. One added case exempts one deleted case of the same name. A
rename therefore counts as a deleted case, and a move to another file does not. The check reports a
deleted case at the line that the target branch declares:

`deletes the test case {name} that {reference} declares on line {line}; keep the case`

## When the target does not resolve

The check reports one problem and fails the run when the target ref does not resolve. The message
names the ref and asks the reader to fetch it. A failure to run `git` reports its own cause without
the fetch hint. The check never skips this gate.

A repository with no commit reports nothing, because a fresh project has no target branch yet. A CI
checkout always has a commit, so the gate still runs there.

CI must fetch the target branch. With `actions/checkout`, set `fetch-depth: 0`. [ADR
0010](./adr/0010-recorded-violations.md) requires the same for recorded violations.

## What each language's own ratchet checks and what it misses

### Rust: Clippy `#[expect]`

Clippy warns when an `#[expect]` no longer fires, so a fixed suppression is removed. It misses an
added `#[allow]`, which never warns, and it says nothing about deleted or skipped tests. In a Rust
project, read the Rust guide at `docs/stomme/languages/rust/guide.md`.

### TypeScript: Oxlint `overrides`

Oxlint `overrides` switch rules off for a set of files. The list is a ratchet only when a test fails
as soon as it grows, such as a shrink-only test over the override list. Oxlint alone does not stop a
new override, and no such test ships in this repository today. With `reportUnusedDisableDirectives`
on, Oxlint reports an unused disable directive, so a stale directive is caught. It does not prevent
a new effective directive, and it says nothing about deleted or skipped tests.

### Go: golangci-lint `new-from-merge-base`

`new-from-merge-base` reports only issues that the merge base does not have. A new lint issue
therefore fails the run, and a fixed issue stops being reported. It compares lint issues, not tests.
A deleted test case or a skip produces no issue, and a suppression directive can hide a new issue.

## What this check misses

The check does not report these forms. Fix them by hand.

- `it.todo` and `test.todo`.
- `#[cfg_attr(..., allow(...))]`.
- `/* @ts-ignore */`.
- A suppression in a config file, such as an Oxlint override, a Vitest `exclude`, or a test command
  flag.
- A test case whose name is not on the same line as its declaration, such as a multi-line TypeScript
  `it.each(...)`.
- An emptied test body that keeps its name.
- An untracked file that was never added to the Git index.

## Recording a problem

A `weakened-test` problem carries no key. `[[violations]]` entries need a key, so they cannot record
a weakened test. Fix the change instead.
