# ADR 0132: Keep QA journeys in separate files

**Date**: 2026-11-12\
**Status**: Accepted

## Context

A tester needs repeatable steps and visible results for a user's goal, including goals tested by
hand. Planning tickets end with a plan, while these checks need to survive it. The QA guide aims for
about 150 lines, so full journeys compete with the instructions every QA run needs.

## Decision

Keep one Markdown file per journey under `.pi/qa/journeys/`, indexed in the QA guide and read by
`qa`, with neither the index nor the files parsed by Tau.

The manager picks journeys from the index for the change and assigns their files. The worker reads
only the assigned journeys and compares their steps' visible results and end states. This keeps the
guide short while preserving checks that run by hand.

The QA guide template owns the journey shape, not a skill. A journey holds steps and visible results
for a tester, not a feature page. This is a reader convention, not a tool, config key, or versioned
saved record.

Keep each whole planned journey once in the container's `## Journeys`, from the marked flows in the
design's `## Usage`. For a design with one slice, keep it in that ticket's `## Design` instead.
Journey files and tests hold only built steps, so QA never receives planned steps as runnable work.

Treat a journey item as a normal slice acceptance item, naming its step range, journey file, and
test file or "by hand". Map every step to a slice. The slice with the last step requires that the
end state holds and the whole journey passes. Block it by each other slice with earlier steps so the
whole-journey check cannot precede its prerequisites.

Give each journey item to one agent ticket that writes the journey file, test, and guide index row
together. A "by hand" item needs no test file. One owner keeps the runnable steps and their index
aligned while the container preserves the whole plan.

## Consequences

### Positive

- Journeys survive the planning ticket and can cover checks run by hand.
- Workers read only the journeys assigned for the change.
- The guide remains an index rather than a collection of full journeys.

### Negative

- Authors must keep the index and journey files aligned without parser checks.
- Visible results can drift and need review when the product changes.

## Alternatives considered

### A Journeys section inside the guide

Put every journey's steps in the guide. Rejected because the guide grows past its 150-line aim and
`qa` reads all journeys on every run.

### Journeys only in the planning ticket

Keep journeys with the plan. Rejected because the journey ends with the plan instead of remaining
available for later QA.

### Planned steps in runnable journey files

Write the whole plan into journey files before its slices deliver it. Rejected because QA would
receive steps it cannot run yet. The container keeps the whole plan without mixing it with built
steps.

### Test files only

Use automated test files as the only record. Rejected because a journey that runs by hand has no
record.
