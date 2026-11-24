# ADR 0001: Documentation scope and the ADR process

**Date**: 2026-11-15\
**Status**: Accepted

## Context

Feature pages restate what code and tests already decide, such as limits, key bindings, and command
behavior. Each feature change must then be made in two places, and the prose drifts from the code.

Code shows what a feature does, but not always why it was designed that way. A project needs one
place for those reasons.

ADRs that never change drift in their own way. When each rule change gets a new ADR that partly
replaces the old one, chains form, and a reader must combine several files to find the current rule.

## Decision

Projects document decisions, not features. ADRs record lasting reasons, and code and tests state
behavior.

### Where content lives

- ADRs record lasting decisions and their reasons. Include only the details needed to understand or
  follow the decision.
- Code and tests state behavior.
- `docs/` holds only what no feature owns: the documentation index, the development guide, the
  coding guide, and the ADRs. A project lists any other document it needs in a bounded field in
  `stomme.toml`, such as a QA guide for agents or a record of local changes to vendored code. Such a
  document names checks, settings, or changes and their reasons, and it explains no feature.
- The root README introduces the project and links to the rest. Topic details go in `docs/` and are
  linked from the documentation index.
- Shared decisions live in these shared ADRs. A project's `docs/adr/` holds only its own decisions,
  numbered on their own.

### Adding and changing documents

Do not add a page that explains how a feature works. Write an ADR only for a choice with a lasting
reason and a credible alternative. Every ADR follows the template, with Context, Decision,
Consequences, and Alternatives considered.

### Keeping ADRs current

- An ADR states the current decision. When its details change, edit the ADR in place, in the same
  change as the code.
- Supersede an ADR only when its core choice reverses. The new ADR then states the whole current
  rule, so a reader never has to combine two ADRs.
- When several ADRs hold parts of one decision, merge them into one ADR that states the whole current
  rule. Its Supersedes line names each merged ADR, and the merged files leave the tree.
- The only status is Accepted. Merging the change is the approval, so there is no Proposed stage. A
  retired ADR leaves the tree.
- The metadata is Date, Status, and at most one Supersedes line and one Related line.
- Do not write ticket IDs, benchmark tables, version numbers, or file lists that go stale. Name a
  file only when the decision is about that file, or when it holds the evidence the ADR rests on.

### The index

The index in the ADR folder's `README.md` groups current ADRs by area. Each entry is one line in
the `- [NNNN: Title](./NNNN-slug.md)` form, whose label repeats the ADR's first heading. A `*` or
`+` bullet works in place of `-`, and an entry may be indented as a nested list item. An ADR file
is named `NNNN-slug.md` with a non-empty slug, and its first heading is `# ADR NNNN: Title` with at
most 3 leading spaces, so Markdown reads it as a heading rather than a code block. The index ends
with a Retired table that gives each retired ADR's number, title, replacement, and last commit.
Numbers are never reused. Git keeps the history, and `git show <commit>:<folder>/<file>` prints a
retired ADR. `stomme check` checks the index against the files.

## Consequences

### Positive

- Fewer descriptions of behavior to keep in sync with code.
- A reader finds the current form of a decision in one ADR.
- A check finds an ADR that the index leaves out, lists twice, or labels wrong.

### Negative

- Readers who want current behavior must read the code and tests.
- A reader who wants a guided tour of a feature does not get one.
- Every change to a decision must update its ADR in the same change, or the ADR drifts from the code.
- The reasoning behind an earlier version of a decision lives only in Git history.

## Alternatives considered

### A page per feature

Keep a page per feature under `docs/`. Rejected because it duplicates behavior defined in code and
can drift as the code changes.

### Pages next to each feature

Move each page next to the code it describes. Rejected because, although it shortens the distance,
it still asks every feature change to update prose that repeats the code.

### A new ADR for every change

Keep each ADR as written and record every change in a new ADR that supersedes it. Rejected because
it builds chains of superseded ADRs, and a reader must combine several files to find the current
rule.

### Copy the shared decisions into each project

Let each project keep its own copy of these decisions in its `docs/adr/`. Rejected because the
copies drift apart, and each project fixes the same wording on its own.
