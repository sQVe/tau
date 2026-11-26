# Shared architecture decision records

These ADRs record the decisions that every project using stomme shares. A project keeps its own
decisions in its own `docs/adr/`, numbered on their own. Shared ADR numbers start at 0001 and do not
follow a project's numbers.

## Before writing

Follow [ADR 0001](./0001-documentation-scope.md) for documentation scope and the ADR process. Before
opening the [template](./TEMPLATE.md), answer:

- What choice are we making for every project, and what lasting reason stands behind it?
- What credible alternative did we consider, and why did we reject it?

If the answers only restate what the code does, do not write an ADR. If the choice holds for one
project only, write it in that project's `docs/adr/`.

Use a title that names the choice, and state that choice in the first sentence of the Decision
section. Give each rejected or deferred alternative its own heading under Alternatives considered.

A shared ADR never names a project, a crate, or a capability. Where a project must fill in a value,
the ADR names the bounded field in `stomme.toml` that holds it.

## Keeping ADRs current

An ADR states the current decision. When its details change, edit it in place. Supersede it only
when the core choice reverses. The new ADR then states the whole current rule and has a Supersedes
line that names the old ADR without a link. Delete the old file, and add a row for it to the Retired
table. Numbers are never reused. To read a retired ADR, run
`git show <commit>:foundation/shared/adr/<file>` in the stomme repository with the commit in its
row.

## Index

### Documentation

- [0001: Documentation scope and the ADR process](./0001-documentation-scope.md)

### Structure

- [0002: Capability modules with a project-owned import table](./0002-capability-modules.md)
- [0003: Owner folders, entry files, and file names](./0003-owner-folders-and-file-names.md)
- [0004: Shared roles, two languages, and framework layers](./0004-roles-languages-and-layers.md)

### Code

- [0005: Typed results, panics for bugs, and parsing once](./0005-results-and-parse-once.md)
- [0006: Side effects as records of functions](./0006-side-effect-records.md)
- [0008: Drop backwards compatibility by default](./0008-backwards-compatibility.md)
- [0010: Recorded violations with a stale check and a growth gate](./0010-recorded-violations.md)

### Tests and review

- [0007: Test placement, names, and fakes](./0007-test-placement-and-fakes.md)
- [0009: Advisory mutation testing and size as a review signal](./0009-advisory-review-signals.md)
- [0011: A weakened-test ratchet against the target branch](./0011-weakened-test-ratchet.md)

## Retired

| ADR | Title | Replacement | Last commit |
| --- | ----- | ----------- | ----------- |
