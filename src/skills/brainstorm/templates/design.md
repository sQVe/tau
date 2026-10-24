# Design

Use this shape for `design.md`. Fill in the sections as the rounds go on, and keep the open
questions current. Start with a title line.

```markdown
# <Title of the design>

## Problem

<What is unclear or missing, and who it affects.>

## Decisions

| Decision           | Choice              | Reason            |
| ------------------ | ------------------- | ----------------- |
| <What was decided> | <The option chosen> | <Why this option> |

## Research findings

- <A fact from the code or docs, with its file path.>

## Criteria

- <A property the design must have.>

## Approaches

| Approach | <Criterion 1> | <Criterion 2> | Notes       |
| -------- | ------------- | ------------- | ----------- |
| <Name>   | <Grade>       | <Grade>       | <One line.> |

Rejected approaches:

- <Name>: <why rejected>. Revisit only if <condition>.

Recommendation: <The approach, and why.>

## Chosen approach

<The approach the user agreed to, in a few sentences.>

## Architecture

- Components: <The parts and what each does.>
- Data flow: <How data moves between the parts.>
- Integration points: <Where the design meets existing code, with file paths.>

## Structure

- Owner: <The existing module that owns the concept, with its path>. Reason: <Why this module owns
  it.>
- Reuse: <Existing modules or helpers to use, with paths>. Reason: <Why each fits.>
- Refactors: <A refactor that must land before this design>. Reason: <Why the design needs it
  first.>

## Acceptance criteria

- [ ] <An outcome a reviewer can check.>

## Non-goals

- <What the design leaves out, and why.>

## Dead ends

- <What was explored>: <what was found>. Dropped because <reason>.

## Open risks

- <A risk that may change the design.>

## Open questions

- <A question the next round must answer.>
```
