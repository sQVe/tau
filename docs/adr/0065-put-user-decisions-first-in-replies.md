# ADR 0065: Put user decisions first in replies

- Status: Accepted
- Date: 2026-09-29

## Context

- The writing instructions told agents to end a reply with the needed information, or with one
  question or decision for the user. That rule put decisions at the bottom of long replies.
- A review of recent Pi sessions showed these problems:
  - In long decision replies, the first question sat near the end, below long status reports.
  - Options did not say what was at stake, and the user asked why each decision mattered.
  - Decisions referred to earlier turns, and the user asked what they meant.
  - Some turns ended without the question.
  - Several decisions were bundled into one sentence.

## Options considered

- Keep the rule to end with the decision. Rejected: long replies keep hiding decisions below the
  report.
- Require `ask_user_question` for every decision. Rejected: the question tool shows options without
  the status and evidence the user needs to choose.
- Put decisions first in the reply, one per number, with lettered options and a recommendation.
  Chosen: the user sees what to decide first and can answer by number and letter.

## Decision

A reply that needs a user decision starts with one sentence of status, then the decisions. The
report and evidence follow.

- Each decision has a number, one question, and one sentence on what it changes or blocks. It must
  read without earlier messages.
- Options use letters. The recommendation comes first and is marked. Each option says in one line
  what happens.
- A yes or no question states the default the agent uses without an answer.
- A skill's own reply or question format takes precedence over these rules, so skills such as
  code-review and pr keep their reports and `ask_user_question` prompts.
- A turn that waits for the user states the question. This rule sits in the workflow instructions
  because it governs when the agent stops, following ADR 0056. The other rules sit in the writing
  instructions.

## Tradeoffs

- The user sees what to decide without reading the report first.
- Each decision can be answered by number and letter.
- Cost: the report comes after the decisions, so a user who wants the evidence first must scroll.
- Cost: short replies with one decision carry more structure than they need.

## See also

- [ADR 0006: Default writing policy](./0006-default-writing-policy.md)
- [ADR 0056: Load workflow rules apart from coding and writing](./0056-load-workflow-rules-apart-from-coding-and-writing.md)
