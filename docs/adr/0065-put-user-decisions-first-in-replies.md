# ADR 0065: Put user decisions first in replies

- Status: Accepted
- Date: 2026-09-29

## Context

The writing instructions told agents to end a reply with the needed information, or with one
question or decision for the user. That rule put decisions at the bottom of long replies.

About 2,100 turn-ending assistant messages from 35 days of Pi sessions showed these problems:

- Among 250 decision replies over 250 words, the first question sat about 96% of the way down, below
  long status reports.
- Options did not say what was at stake. The user asked "Tell me why my decision is important for
  each of these bullets" and "give me options to respond to for each point".
- Decisions referred to earlier turns, such as "decide whether blocking TDD stays first". The user
  replied "What do you mean?"
- Some turns ended without the question. The user asked "What is the scope question?" and "So, what
  is the verdict?"
- Several decisions were bundled into one sentence.

## Options considered

- Keep the rule to end with the decision. Long replies keep hiding decisions below the report.
- Require `ask_user_question` for every decision. The question tool shows options without the status
  and evidence the user needs to choose, so it hides the context.
- Put decisions first in the reply, one per number, with lettered options and a recommendation.
  Choose this option.

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
