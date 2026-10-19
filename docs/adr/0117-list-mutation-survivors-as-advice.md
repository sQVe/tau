# ADR 0117: List mutation survivors as advice instead of a gate

**Date**: 2026-10-18\
**Status**: Accepted; disable-comment step of the survivor order superseded by
[ADR 0118 (List equivalent mutants instead of adding disable comments)](./0118-list-equivalent-mutants-instead-of-disable-comments.md)\
**Supersedes**:
[ADR 0115 (Copy the mutation script into each repository and fail on survivors)](./0115-copy-mutation-script-per-repository-and-fail-on-survivors.md):
use of survivors as a gate

## Context

ADR 0115 made a survivor on a changed line fail the check, so the `pr` skill stopped publication
until each survivor had a test, simpler code, or a disable comment. Mutation testing exists to find
weak tests. A stop at publication turns it into one more step to clear before a change can ship. The
user put it this way: "We want to use this to IMPROVE our tests, not add more hoops that we need to
jump through."

## Decision

Mutation testing is advice at publication and merge: survivors and errors of the check never block
either one.

The `pr` skill still runs `mutation_check` on the changed lines after the full check. It lists each
survivor with its file, line, and change in the pull request, reports a tool error on its own line,
and publishes. Neither counts as a gap that suggests a draft. The `Mutation` CI job is not a
required status check, so a failed job does not block a merge.

The `tdd` skill still asks the agent to handle each survivor before hand-off, in the order of
ADR 0115. That step improves the tests while the agent still has the change in context. It is not a
gate on publication. The script keeps its exit codes, so a tool or CI job can still tell survivors
from a pass.

## Consequences

### Positive

- A change ships without waiting for every survivor to be resolved.
- Reviewers see the survivors in the pull request and can ask for a test where one matters.

### Negative

- A survivor can reach the main branch with no test that kills it.
- The CI job shows as failed on a pull request with survivors, even though the merge may go ahead.

## Alternatives considered

### Keep survivors as a stop before publication

Keep ADR 0115's rule in the `pr` skill. Rejected because it adds a step to every pull request for a
check whose purpose is to improve tests, and equivalent mutants still need a disable comment before
anything ships.

### Drop the mutation check from the `pr` skill

Run mutation testing only in the `tdd` skill and CI. Rejected because the pull request is where a
reviewer reads the change, and the survivor list helps them judge the tests there.
