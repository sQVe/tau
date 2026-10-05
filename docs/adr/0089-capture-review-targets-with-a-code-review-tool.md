# ADR 0089: Capture review targets with a code_review tool

- Status: Accepted
- Date: 2026-10-05
- Supersedes: the rule "Add no review tools or review state" in
  [ADR 0060](./0060-keep-local-code-review-in-a-skill.md)

## Context

- ADR 0060 kept code review in the `code-review` skill and allowed no review tools or review state.
- The skill then captured the target and checked freshness with shell blocks. Shell in a skill has
  no tests, and the capture had to handle revisions, untracked files, submodules, and symlinks.
- Reviewers must read the same bytes the parent captured. The parent must know whether the target
  changed before it reports.
- The rejected review engine registered candidates and bound verdicts to workers. That proved which
  task saved a verdict, not whether it was right.

## Options considered

- Keep the capture and freshness check as shell in the skill. Rejected: the shell is untested, and
  every edit to it risks a wrong capture.
- Bring back the review engine. Rejected: for the reasons in ADR 0060.
- Add a `code_review` tool that holds only the capture and freshness mechanics. Chosen: tests cover
  the mechanics, and review judgment stays in the skill.

## Decision

Tau has one review tool, `code_review`. It prepares a review directory, captures the target, saves a
capture record, and checks whether the capture is still fresh.

- Review stays in the `code-review` skill. Findings stay advisory.
- The capture record is the only review state. It holds the pinned target and the capture hash, so
  freshness can compare them with the checkout.
- The tool does not register candidates, bind verdicts to workers, or prove a verdict.

## Tradeoffs

- Tests cover the capture and the freshness check.
- Reviewers read one fixed capture, and the report says when the target changed.
- Cost: Tau maintains a review tool and a saved record format.
- Cost: freshness covers only the captured target, not callers or rules outside it.

## See also

- [ADR 0060: Keep local code review in a skill](./0060-keep-local-code-review-in-a-skill.md)
- [ADR 0088: Grow skills into tools and templates](./0088-grow-skills-into-tools-and-templates.md)
