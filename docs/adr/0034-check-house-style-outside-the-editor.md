# ADR 0034: Check house style outside the editor

**Date**: 2026-09-21\
**Status**: Accepted; size limits superseded by
[ADR 0035 (Use size thresholds as review guidance)](./0035-use-size-thresholds-as-review-guidance.md)

## Context

[ADR 0008](./0008-coding-instructions.md) left code layout to prompt instructions, which cannot
guarantee consistent style. Mechanical checks can enforce a useful subset, but showing every style
violation while typing would crowd out correctness diagnostics.

Oxlint can now run ESLint-compatible JavaScript plugins, so style rules no longer need a second
linter. Its plugin interface remains alpha.

## Decision

Enforce house style through explicit commands, project checks, and staged-file hooks, not live
editor diagnostics. Enabling house-style rules only in explicit commands and required checks keeps
the existing runner and separates style enforcement from live diagnostics. This replaces ADR 0008's
decision against mechanical layout checks. Its coding instructions still cover judgments that lint
cannot make, including where logical steps begin.

Prefer native Oxlint rules, then compatible plugins, then local rules. Local rules are needed for
naming because the typescript-eslint naming rule requires parser services this integration lacks.

Limit size and density with the same checks: 60 lines and 4 parameters per function, 500 lines per
file, and 3 checks per condition with no mixed `&&` and `||`. Complexity 12 and nesting depth 3 stay
ordinary diagnostics. The limits sit in the middle of what ESLint, XO, golangci-lint, RuboCop, and
Biome use. Test files are exempt from the size limits.

Keep renames and helper movement manual. Allow narrow, explained suppressions for external contracts
and callback cycles.

## Consequences

### Positive

- Required checks enforce style without adding live editor diagnostics.

### Negative

- Style violations appear only when the developer runs a style command or required check.
- Plugin compatibility must be tested when updating Vite+ or ESLint Stylistic.
- Syntax-only rules cannot judge every naming or ordering case.

## Alternatives considered

### Instructions alone

Keep instructions alone. Rejected because, although it avoids tooling work, it cannot enforce the
mechanical rules.

### Every rule in the editor

Enable every rule in the editor. Rejected because, although it gives immediate feedback, it adds
unwanted style diagnostics.

### Separate ESLint runner

Add a separate ESLint runner. Rejected because, although it reuses ESLint rules, it duplicates the
lint pipeline and configuration.
