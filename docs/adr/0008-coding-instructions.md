# ADR 0008: Coding instructions

- Status: Accepted
- Date: 2026-09-09

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

### The comment rules are stated twice on purpose

The comment review gate in [`commentReview.ts`](../../src/extensions/commit/commentReview.ts) sends
its policy as the whole system prompt for a separate model call. That call never receives the Tau
prompt, so the policy cannot link to the coding instructions. It states the comment rules itself.

Keep both statements in agreement. The instructions guide the agent as it writes; the gate decides
whether a commit passes. If the gate protects a comment the instructions do not mention, the agent
may delete it and block the commit. Change both files together.

### Types

This extension defines no types of its own and may omit `types.ts`, an exception to ADR 0001.

## Tradeoffs

- Each concern has one file, so a rule about code is not read as a rule about prose.
- Ordinary runs receive the rules without loading a skill.
- Cost: a second policy uses more space in the prompt on every run.
- Cost: two instruction files can drift apart. Keep comment rules on one side of the boundary.
- Cost: the comment rules also appear in the review policy in
  [`commentReview.ts`](../../src/extensions/commit/commentReview.ts), which the decision above
  explains. Both statements must change together.
- Cost: prompt instructions cannot guarantee readable code, and other extensions can replace them.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0006: Default writing policy](./0006-default-writing-policy.md)
- [Agent coding instructions](../../src/extensions/coding/instructions.md)
- [Comment review policy](../../src/extensions/commit/commentReview.ts)
