---
'tau': patch
---

`architect` `open` and the hidden route of `ask` take the architect lock before they start Pi. A
second caller is refused before it starts Pi or writes an ask record. A one-shot start ticket fences
each launch: the lead creates `<token>.lead.<leadPid>`, the child renames it to
`<token>.lead.<leadPid>.started.<childPid>`, and `exec` keeps that child ID for Pi. A caller that
abandons a launch cancels the ticket and releases its claim only when the rename proves no Pi can
run, or when the kernel reports the marker's process gone. `running` and `unknown` keep the claim
and the marker. The caller stops a taken child by process ID with `SIGTERM` and then `SIGKILL`,
within one absolute 10 second deadline. Absence from `hc` no longer releases a claim, deletes a
marker, or refuses a start.

The caller keeps its own copy of the child's process ID and whether it has seen its adopted marker.
Neither a later read nor another caller's lock changes that copy. After the architect takes the
claim over, it renames its marker to `<token>.lead.<leadPid>.adopted.<childPid>` and keeps it. The
caller counts the child as adopted when it has seen its own adopted marker, or when the live lock
holder's process ID is the child's. A different token or process ID is never its child's takeover.
Adoption ends the fence: after it, the fence never signals the child, and the claim release decision
receives `adopted: true`. A hidden ask whose launch reply gives no address but whose child adopted
waits on the child's process ID instead of abandoning it, then reports from its locked record.

A sweep deletes a started marker whose process is gone, even when its finished terminal was removed,
and otherwise refuses with the process ID. A `.started` name without a valid process ID refuses with
the marker path. An adopted marker refuses a later start until the kernel reads its child as gone.
Once the child is gone, a live lead keeps the marker as its evidence. The sweep leaves the marker
while its child or its lead is running or unknown, and deletes it only when the kernel reads both as
gone. The lead deletes its own markers once its child is gone, so it always settles a hidden ask
whose Pi stopped without its shutdown handler. Hidden ask records change only while they are
`running`, under the per-ask lock, so `sent`, `timeout`, and `failed` are final. The lead reports
`timeout` and `sent` from the locked record after its wait. A hidden ask enforces its own deadline,
and a reader repairs a running ask whose recorded terminal has ended.
