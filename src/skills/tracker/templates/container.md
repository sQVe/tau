# Container

Use this shape for a human ticket that groups slices. Its slices are its children. The container
holds no full design: it holds a short summary and one line per key decision. Each slice's
`## Design` holds the rules that slice follows. Leave out optional sections that have nothing to
say.

```markdown
One to three sentences on what the design delivers and why.

## Problem

Optional. What is wrong or missing today, and who it affects.

## Decisions

- One line for each key decision of the design.

## Out of scope

Optional. Work a reader might expect here that the design leaves out.

## Acceptance

- [ ] An observable result of the whole design. Each one maps to at least one slice.
```
