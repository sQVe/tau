# Writing docs

Keep the root README focused on the project introduction and links. Put topic-specific details in
`docs/` and link them from the documentation index.

## Where things go

- `adr/`: lasting technical decisions and their reasons. Accepted ADRs may define current
  conventions; proposed ADRs are not requirements.
- Keep development, maintenance, and project information directly in `docs/`.
- Keep agent instructions beside the extension that loads them.

Keep related explanations and steps together. Split a document when its topics are useful to read
independently, not just because it answers more than one kind of question.

## Writing

- Follow the [writing instructions](../src/extensions/writing/instructions.md).
- Use the [ADR template](./adr/TEMPLATE.md) for decisions. For other docs, choose headings that help
  readers find what they need. Remove template instructions before publishing.
- Use sentence case, concrete language, and language tags on code blocks.
- Name files in lowercase kebab-case; prefix ADRs with a four-digit sequence number.
- Link to existing explanations and rules instead of copying them.

## Keep one source for each rule

An accepted ADR can define a current convention. Record changes to what a decision requires in a new
ADR that replaces it; do not silently change the rules.

Keep command definitions and tool versions in repository configuration. Development docs should
explain how to use them and link to the relevant files.

## Before finishing

Check local links, verify commands against the repository, and remove wording that adds no meaning.
