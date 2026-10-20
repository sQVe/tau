# ADR 0118: List equivalent mutants instead of adding disable comments

**Date**: 2026-10-19\
**Status**: Accepted\
**Supersedes**: [ADR 0115 (Copy the mutation script into each repository and fail on survivors)](./0115-copy-mutation-script-per-repository-and-fail-on-survivors.md):
the disable-comment rule

## Context

ADR 0115 told agents to write `// Stryker disable next-line <mutator>: <reason>` for a true
equivalent mutant, and its survivor order kept that step. Agents then used the comment as the easy
way to clear a survivor. Phi's PR #70 added 129 disable comments to 25 production files, and many of
them hid real test gaps.

A comment in production code also costs readers. It names a tool, it stays after the code changes,
and nobody rechecks whether the mutant is still equivalent. The survivor list is advice, so an
equivalent mutant does no harm there.

## Decision

No repository adds `Stryker disable` comments. A mutant that is equivalent stays in the survivor
list as an open item.

The survivor list is the only record of an equivalent mutant, and the `tdd` skill needs no reason
for it (see ADR 0117). The `triage-findings` skill points to the mutation step of the `tdd` skill.
The script and Stryker still honor comments that already exist.

## Consequences

### Positive

- A survivor is fixed with a test or simpler code, or it stays visible in the list.
- Production code carries no tool markers.

### Negative

- An equivalent mutant shows up in every run until the code changes.
- Nothing records why a mutant is equivalent.

## Alternatives considered

### Keep disable comments with a required reason

Agents keep writing the comment for a true equivalent mutant. Rejected because agents wrote it for
mutants that were real test gaps, and a reason in a comment is not checked.

### Ignore mutants through a list in the configuration

A central file names the equivalent mutants. Rejected because it adds a second place to maintain and
has the same abuse risk as a comment.
