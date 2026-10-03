# ADR 0084: Keep the diagram skill out of worker profiles

- Status: Accepted
- Date: 2026-10-03

## Context

- The `diagram` skill draws Mermaid diagrams. Pi renders only top-level `mermaid` blocks in
  assistant replies, and GitHub renders them in pull requests and documents.
- Skills that explain structure, such as `slice` and `pr`, and the `explain` and `simplify` snippets
  now ask for diagrams.
- A worker report reaches the manager as notice text. Mermaid in that text does not render, so the
  user would see raw source.

## Options considered

- Load the `diagram` skill in every worker profile. Rejected: worker reports would carry Mermaid
  source that nobody sees rendered, and each worker would load a skill it cannot use well.
- Load it only in the manager, and let the manager draw diagrams from worker evidence. Chosen: the
  manager's reply is where diagrams render, and the manager already restates worker reports.

## Decision

Worker profiles do not load the `diagram` skill. Workers report structure as prose with file and
line evidence. The manager draws any diagram the user needs from that evidence, in its own reply.

## Tradeoffs

- Diagrams appear only where they render.
- Worker reports stay plain text the manager can quote and check.
- Cost: the manager reads the worker's evidence to draw a diagram, instead of reusing one.

## See also

- [ADR 0067: Give workers only their profile's tools and skills](./0067-give-workers-only-their-profile-tools-and-skills.md)
