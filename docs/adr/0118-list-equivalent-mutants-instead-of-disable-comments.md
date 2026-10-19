# ADR 0118: List equivalent mutants instead of adding disable comments

**Date**: 2026-10-19\
**Status**: Accepted\
**Supersedes**: [ADR 0115 (Copy the mutation script into each repository and fail on survivors)](./0115-copy-mutation-script-per-repository-and-fail-on-survivors.md):
the disable-comment rule

## Context

ADR 0115 told agents to write `// Stryker disable next-line <mutator>: <reason>` for a true
equivalent mutant. ADR 0117 kept that step in the survivor order. Agents then used the comment as
the easy way to clear a survivor. Phi's PR #70 added 129 disable comments to 25 production files,
and many of them hid real test gaps.

A comment in production code also costs readers. It names a tool, it stays after the code changes,
and nobody rechecks whether the mutant is still equivalent. The survivor list is advice, so an
equivalent mutant does no harm there.

## Decision

No repository adds `Stryker disable` comments. A mutant that is equivalent stays in the survivor
list, and the report gives its reason.

The `tdd` skill stops rerunning `mutation_check` once the full check passes and every remaining
survivor is listed as equivalent with its reason. The `triage-findings` skill reports such a mutant
as Not worth changing, and the `pr` skill adds the reason to the survivor line. The script and
Stryker still honor comments that already exist.

## Consequences

### Positive

- A survivor is fixed with a test or simpler code, or it stays visible with a reason.
- Production code carries no tool markers.

### Negative

- An equivalent mutant shows up in every run until the code changes.
- The reason lives in a report, not next to the code.

## Alternatives considered

### Keep disable comments with a required reason

Agents keep writing the comment for a true equivalent mutant. Rejected because agents wrote it for
mutants that were real test gaps, and a reason in a comment is not checked.

### Ignore mutants through a list in the configuration

A central file names the equivalent mutants. Rejected because it adds a second place to maintain and
has the same abuse risk as a comment.
