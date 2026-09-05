# Writing docs

Keep the root README focused on the project introduction and links. Put topic-specific details in
`docs/` and link them from the documentation index.

## Where things go

- `adr/`: durable technical decisions and their reasons. Accepted ADRs may define current
  conventions; proposed ADRs are not requirements.
- `guides/`: setup, workflows, and maintenance instructions.
- `foundations/`: project direction and scope.
- `policies/`: current rules that need a standalone reference. Link to the relevant ADR for its
  rationale instead of duplicating it.

Keep related explanations and steps together. Split a document when its topics are useful to read
independently, not just because it answers more than one kind of question.

## Writing

- Use the [ADR](./adr/TEMPLATE.md), [guide](./guides/TEMPLATE.md),
  [foundation](./foundations/TEMPLATE.md), and [policy](./policies/TEMPLATE.md) templates as
  starting points. Adapt headings and omit optional sections that add no useful information. Remove
  template instructions before publishing.
- Use sentence case, concrete language, and language tags on code blocks.
- Name files in lowercase kebab-case; prefix ADRs with a four-digit sequence number.
- Link to existing explanations and rules instead of copying them.

## Keep one source for each rule

An accepted ADR can define a current convention. When a separate policy becomes useful, link to it
from the ADR as the current rule reference and preserve the decision's reasoning. Record material
changes to the decision in a successor ADR; do not silently change the rules during extraction.

Keep command definitions and tool versions in repository configuration. Guides should explain how to
use them and link to the relevant files.

## Before finishing

Check local links, verify commands against the repository, and remove wording that adds no meaning.
