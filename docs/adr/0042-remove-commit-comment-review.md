# ADR 0042: Remove commit comment review

- Status: Accepted
- Date: 2026-09-24
- Supersedes: [ADR 0038](./0038-block-commits-only-on-comment-inaccuracies.md) and the review rules
  in [ADR 0026](./0026-let-git-hooks-own-commit-checks.md)

## Context

The `commit` tool sent each staged tree to a model that reviewed its comments before Git hooks ran.
Blocking findings returned tool errors, and a group was refused after two returns.

The gate blocked commits over comment wording, not over code. In one session, a checked and passing
UI commit could not land. The agent rewrote a flagged comment, and the reviewer raised a new
objection to it. The agent deleted the comment, and the reviewer then refused the commit over an
older comment it had not flagged before. The user had to step in.

Pi session logs show the same pattern. They contain 386 "needs corrections" blocks in 67 sessions,
180 refusals after two returns, 78 `commentDispute` workarounds, and about 100 failures where the
reviewer itself failed. The same logs show about 93 successful commit groups.

The gate was already patched four times: lockfiles skipped, findings batched, a verifier added, and
policy findings made advisory in ADR 0038. It still blocked on judgment calls, because a model can
always find a new objection to a comment.

## Options considered

- Keep the gate and patch it again. Earlier patches narrowed what blocks, but each retry still gets
  a fresh review that can raise a new finding on unchanged code.
- Make every finding advisory. Commits no longer block, but each commit still pays for a model call
  and returns reports that agents tend to act on.
- Move comment review to pull request review. Code and PR review can already catch wrong comments
  without a separate commit step.
- Remove comment review. Git hooks remain the only commit gate.

## Decision

Remove comment review from the `commit` tool. Git hooks are the only commit gate. Wrong comments are
left to code and pull request review.

The tool keeps its staging, path, HEAD, and hook-failure rules from ADR 0026. It no longer accepts
`commentDispute` or reports a review. The shared delegate from ADR 0027 remains for bulk reads and
web answers.

## Tradeoffs

- Agents and users no longer stop on comment wording, and commits make no model call.
- The comment rules live only in the coding instructions, so they cannot drift from a second copy.
- Cost: inaccurate comments can land in history until code or pull request review catches them.
