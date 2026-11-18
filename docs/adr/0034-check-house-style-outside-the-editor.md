# ADR 0034: Check house style outside the editor

**Date**: 2026-09-21\
**Status**: Accepted\
**Supersedes**: [ADR 0035 (Use size thresholds as review guidance)](./README.md#retired),
[ADR 0046 (Declare types before values, except types derived with `typeof`)](./README.md#retired)

## Context

[ADR 0006](./0006-default-writing-policy.md) left code layout to prompt instructions, which cannot
guarantee consistent style. Mechanical checks can enforce a useful subset, but showing every style
violation while typing would crowd out correctness diagnostics.

Oxlint can run ESLint-compatible JavaScript plugins, so style rules need no second linter.

## Decision

Enforce house style through explicit commands, project checks, and staged-file hooks, not live
editor diagnostics.
[`@sqve/stomme-ts-style`](https://github.com/sQVe/stomme/tree/main/packages/style) provides the
house-style rules and runs them only through its `stomme-ts-style` command, so editors keep ordinary
diagnostics. Limiting house-style rules to explicit commands and required checks separates style
enforcement from live diagnostics. This replaces
[ADR 0008 (Coding instructions)](./README.md#retired)'s decision against mechanical layout checks.
The coding instructions in [ADR 0006](./0006-default-writing-policy.md) still cover judgments that
lint cannot make, including where logical steps begin.

Prefer native Oxlint rules, then compatible plugins, then local rules. The package provides the
naming rule, so this repository needs no naming rule of its own.

Size is review guidance, not a lint gate, as
[shared ADR 0009](../stomme/shared/adr/0009-advisory-review-signals.md) decides.

The package's `seam/max-condition-checks` rule enforces the condition limit in the coding
instructions and rejects a condition that mixes `&&` and `||`. Complexity and nesting depth stay
ordinary lint diagnostics, so editors show them too.

Keep renames and helper movement manual. Allow narrow, explained suppressions for external contracts
and callback cycles. The package requires a reason for each suppression.

Module-level types and interfaces, exported or not, go below the imports and above values. This also
applies to tests and fixtures. A type that uses `typeof` on a value declared in the same module
stays beside that value. A type derived from such a type moves up with the other types. The
package's `seam/type-placement` rule enforces this and can move the type.

## Consequences

### Positive

- Required checks enforce style without adding live editor diagnostics.

### Negative

- Style violations appear only when the developer runs a style command or required check.
- Check the house-style rules after updating `@sqve/stomme-ts-style` or Vite+, because the package
  runs them through Vite+.
- Syntax-only rules cannot judge every naming or ordering case.
- No lint rule checks function or file length, so reviewers must judge boundaries themselves.

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

### Mandatory size limits

Keep mandatory size limits. Rejected, as
[shared ADR 0009](../stomme/shared/adr/0009-advisory-review-signals.md) decides.

### Hoist every type

Hoist every type. Rejected because it separates each TypeBox type from its schema.

### Exempt types built with named helpers

Exempt types built with named helpers such as `Static` or `ReturnType`. Rejected because it needs a
list that grows with every new helper and misses `typeof value` alone.

### Exempt types that reference an exempt type

Exempt a type that references an exempt type. Rejected because, although it keeps chains such as
`Extract<Task, { version: 1 }>` together, an interface that only uses a TypeBox type in one field
would never move.
