# Architecture decision records

ADRs capture durable technical decisions and the tradeoffs behind them.

## When to write one

Write an ADR for architecture choices, technical tradeoffs, and decisions whose consequences outlive
the PR that introduced them.

Do not write an ADR for general guidance, contributor instructions, normative policies, or temporary
notes.

## Approval

ADRs may be drafted before approval, but they must not be marked `Accepted` until the project owner
approves them explicitly.

## Naming

- `NNNN-short-kebab-case.md`.
- Numbers are zero-padded and chronological.

## Required format

Every ADR follows the [template](./TEMPLATE.md).

Required sections: Status, Date, Context, Options considered, Decision, Tradeoffs.

Optional sections: See also.

## Index

- [0001: Application structure](./0001-application-structure.md)
- [0002: File and directory naming conventions](./0002-file-naming-conventions.md)
- [0003: Stability of externally observable identifiers](./0003-externally-observable-identifiers.md)
- [0004: Skill authoring style](./0004-skill-authoring-style.md)
