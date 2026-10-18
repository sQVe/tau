# ADR 0116: Name the mutation command in the repository file

**Date**: 2026-10-18\
**Status**: Accepted\
**Extends**: [ADR 0115 (Copy the mutation script into each repository and fail on survivors)](./0115-copy-mutation-script-per-repository-and-fail-on-survivors.md)\
**Related**:
[ADR 0110 (Keep QA settings in a per-feature repository map)](./0110-keep-qa-settings-in-a-per-feature-repository-map.md)

## Context

The `full_check` tool runs a command that only the user file names, because the check runs in every
checkout of the user and a repository file must not choose what runs on their machine. The mutation
script is different. Each repository carries its own copy of `scripts/mutation.ts` (ADR 0115), so
the script and the command that runs it change together in one commit.

## Decision

The `mutation_check` tool reads its command from `mutation.argv` in `.pi/tau.json` in the
repository, and refuses the key in the user file.

The command lives beside the script it runs, so a branch that changes the script changes the command
in the same commit. The key is read through the project trust gate, so an untrusted repository
cannot make Tau run a command. The error for a missing key says whether trust hid the file.

The tool lives in the `fullCheck` extension and shares the lock, log, and reuse code of
`full_check`. A full check and a mutation check of one repository never run at once, since both use
the same test resources. Only a run whose report says `pass` or `nothing` is saved for reuse, so an
audit run with survivors that exits 0 is never reused.

## Consequences

### Positive

- The command and the script cannot drift apart.
- No user setup is needed for a repository that carries the script.
- Mutation runs and full checks do not compete for the same resources.

### Negative

- A trusted repository decides which command runs. The user accepts this by trusting the project.
- A mutation run waits for a long full check, and the reverse.

## Alternatives considered

### Name the command in the user file

Put `mutation.repositories.<owner/name>.argv` in the user file, as `fullCheck` does. Rejected
because every user must copy a command that the repository already knows, and it drifts from the
script.

### A separate extension and lock

Give the tool its own extension and lock. Rejected because the extension boundary rule blocks shared
imports, and a separate lock would let a mutation run and a full check compete for resources.
