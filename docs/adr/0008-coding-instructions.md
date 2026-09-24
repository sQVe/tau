# ADR 0008: Coding instructions

- Status: Accepted; the duplicated comment rules were removed by
  [ADR 0042](./0042-remove-commit-comment-review.md)
- Date: 2026-09-09

[ADR 0034](./0034-check-house-style-outside-the-editor.md) replaces the decision against mechanical
layout checks. The remaining decisions below still apply.

## Context

- ADR 0006 loads one writing policy into every ordinary agent run. It covers replies, commit and PR
  text, tickets, docs, and code comments.
- Nothing tells the agent how to shape code. Rules such as separating the logical steps inside a
  function with a blank line have no home in Tau.
- Tools cannot enforce these rules. Oxlint ships no layout rules, and the formatter keeps the blank
  lines an author writes but never adds them.
- The writing policy mixes two concerns in its comment rules: how a comment reads, and whether the
  comment should exist at all.

## Options considered

- Add the rules to the writing policy. One extension already loads instructions, but a prose policy
  should not also govern code structure.
- Enforce the rules with lint. Oxlint has no layout rules, and adding a second linter for them was
  rejected. A rule that matches statement types cannot see logical steps anyway.
- Extend the comment review gate to block unreadable code. The gate gives evidence for concrete
  defects. Readability is a judgment call, so it would block commits on opinion.
- Load a second policy through its own extension. Matches ADR 0006 and keeps one concern per file.

## Decision

Add `src/extensions/coding/`. It loads
[`instructions.md`](../../src/extensions/coding/instructions.md) into the system prompt before each
ordinary agent run, following the runtime integration ADR 0006 describes for writing. Reject
missing, unreadable, or blank guidance when loading Tau, for the reasons ADR 0006 gives.

### Boundary with the writing policy

- `writing/instructions.md` governs text. This includes the wording of code comments.
- `coding/instructions.md` governs code. This includes whether a comment should exist.

This amends the scope ADR 0006 records. The writing policy still covers code comments as prose. The
judgment about which comments to keep or remove moves to the coding instructions.

### Each extension loads its own file

Both extensions read a markdown file and append it to the system prompt. The shared code is about
ten lines, and ADR 0001 allows a primitive once two extensions could share one.

Keep the duplicate loaders anyway. The tests copy `index.ts` into a temporary directory and load it
through `DefaultResourceLoader`, so a relative import outside the extension directory cannot
resolve. Extract the loader only together with a test setup that does not copy the file.

### The comment rules are stated once

This section first kept a second copy of the comment rules in the commit comment review policy.
[ADR 0042](./0042-remove-commit-comment-review.md) removed that review, so the coding instructions
are the only statement.

### Types

This extension defines no types of its own and may omit `types.ts`, an exception to ADR 0001.

## Tradeoffs

- Each concern has one file, so a rule about code is not read as a rule about prose.
- Ordinary runs receive the rules without loading a skill.
- Cost: a second policy uses more space in the prompt on every run.
- Cost: two instruction files can drift apart. Keep comment rules on one side of the boundary.
- Cost: prompt instructions cannot guarantee readable code, and other extensions can replace them.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0006: Default writing policy](./0006-default-writing-policy.md)
- [Agent coding instructions](../../src/extensions/coding/instructions.md)
- [ADR-0042: Remove commit comment review](./0042-remove-commit-comment-review.md)
