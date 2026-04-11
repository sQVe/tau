# Writing docs in this directory

Rules for any agent (or human) writing or editing files under `docs/`.

## Pick the doc type first

| Type       | Answers                                  | Template                                             |
| ---------- | ---------------------------------------- | ---------------------------------------------------- |
| ADR        | What did we decide, and why?             | [adr/TEMPLATE.md](./adr/TEMPLATE.md)                 |
| Policy     | What is required, allowed, and enforced? | [policies/TEMPLATE.md](./policies/TEMPLATE.md)       |
| Guide      | How do I do this?                        | [guides/TEMPLATE.md](./guides/TEMPLATE.md)           |
| Foundation | What is Tau trying to be?                | [foundations/TEMPLATE.md](./foundations/TEMPLATE.md) |

If the doc answers two of these questions, split it.

## Hard rules

- Use the template verbatim. Do not invent sections. Do not reorder them.
- Sentence case for every heading (APA style).
- One `## See also` section for cross-links. Never "Related ADRs", "Related policies", "References".
- Inline Markdown links only. No reference-style.
- Language tag on every code block.
- Frontmatter list uses `Status` and `Date` (ADR) or `Last updated` (others). No `Owner`, no
  `Deciders`.

## Writing rules

- Imperatives over descriptions. "State the decision." not "This section describes the decision."
- Bullets over prose in Context, Options considered, Tradeoffs, In scope, Out of scope.
- One-sentence Decision. Add subsections only when the decision has distinct parts.
- Cut hedge words: _briefly_, _clearly_, _concretely_, _simply_, _basically_, _in general_.
- Active voice. Positive form. Specific, concrete language.
- No trailing summaries or "in conclusion" paragraphs.

## Cross-template vocabulary

Each template has one "why this exists" section. Do not drift between them.

| Template   | Section         | Job                                |
| ---------- | --------------- | ---------------------------------- |
| ADR        | `Context`       | Forces driving the decision.       |
| Policy     | `Applies to`    | What the policy governs and where. |
| Guide      | `Use this when` | The reader's trigger.              |
| Foundation | `The idea`      | The core claim in one paragraph.   |

## ADR specifics

- `Options considered` is required. List at least two. If only one option was seriously weighed,
  state the null alternative ("keep current state") and why it fails.
- `Tradeoffs` is one list. Benefits are plain bullets; prefix cost bullets with `−`. Do not split
  Positive/Negative.
- Mark `Status: Accepted` only after the project owner approves.

## Before you commit

- [ ] Matches the template section-for-section.
- [ ] Frontmatter filled in.
- [ ] Every link resolves.
- [ ] Prose cut by one pass: delete every word that does not change meaning.
- [ ] No invented headings, no "Related X" variants, no hedge words.
