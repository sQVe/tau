# ADR 0034: Check house style outside the editor

- Status: Accepted
- Date: 2026-09-21

## Context

[ADR 0008](./0008-coding-instructions.md) left code layout to prompt instructions, which cannot
guarantee consistent style. Mechanical checks can enforce a useful subset, but showing every style
violation while typing would crowd out correctness diagnostics.

Oxlint can now run ESLint-compatible JavaScript plugins, so style rules no longer need a second
linter. Its plugin interface remains alpha.

## Options considered

- Keep instructions alone. Avoids tooling work but cannot enforce the mechanical rules.
- Enable every rule in the editor. Gives immediate feedback but adds unwanted style diagnostics.
- Add a separate ESLint runner. Reuses its rules but duplicates the lint pipeline and configuration.
- Enable house-style rules only in explicit commands and required checks. Keeps the existing runner
  and separates style enforcement from live diagnostics.

## Decision

Enforce house style through explicit commands, project checks, and staged-file hooks, not live
editor diagnostics. This replaces ADR 0008's decision against mechanical layout checks. Its coding
instructions still cover judgments that lint cannot make, including where logical steps begin.

Prefer native Oxlint rules, then compatible plugins, then local rules. Local rules are needed for
naming because the typescript-eslint naming rule requires parser services this integration lacks.

Keep renames and helper movement manual. Allow narrow, explained suppressions for external contracts
and callback cycles.

## Tradeoffs

- Required checks enforce style without adding live editor diagnostics.
- Cost: style violations appear only when the developer runs a style command or required check.
- Cost: plugin compatibility must be tested when updating Vite+ or ESLint Stylistic.
- Cost: syntax-only rules cannot judge every naming or ordering case.
