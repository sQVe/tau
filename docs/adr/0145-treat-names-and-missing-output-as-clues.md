# ADR 0145: Treat names and missing output as clues, not evidence

**Date**: 2026-11-20\
**Status**: Accepted\
**Related**: [ADR 0006 (Load Tau's instruction sets into every prompt)](./0006-default-writing-policy.md)

## Context

A session can report an integration or workflow as missing or disabled from a directory scan or an
absent output. Both can be wrong. A workflow caller can be renamed, so the expected file is absent
while the workflow runs. An integration can run in Silent mode, so it writes no visible output. A
negative report then sends the user to fix something that works.

The configuration or run record the system keeps settles the question. It can be a workflow file, an
app log, or a run record. It can also be unreadable.

## Decision

Tau treats filenames and missing outputs as clues only. Before an ordinary session reports an
integration or workflow as missing or disabled, it reads the system's own configuration or run
record. If that source cannot be read, it reports `unknown` and names the source.

A source that the session cannot access, or whose absence is proven, leaves the fact unsettled. A
conventional name that does not exist, or an expected output that did not appear, does not settle
it.

## Consequences

### Positive

- A report of missing or disabled rests on the system's own record, so a renamed caller or a silent
  run does not produce a false negative.
- An unreadable source gives `unknown` and a named path, which the user can act on.

### Negative

- Each such report needs a read that a scan would skip, so the session spends a tool call.
- A source that does not exist makes the answer `unknown` even when the integration is likely
  absent.
- A session can still misread a source it opens.

## Alternatives considered

### Infer a negative from names and outputs

Report missing or disabled when the conventional filename is absent or the expected output does not
appear. Rejected because a renamed caller and Silent mode leave both absent while the integration is
present. The scan is quick, but its false negative costs the user a wrong fix.

### Report nothing when the source is unreadable

Leave the fact out of the reply. Rejected because the user asked about it, and silence reads as a
negative. `unknown` with the source named states what is missing.
