---
'tau': patch
---

`architect` `open` and the hidden route of `ask` take the architect lock before they start Pi. A
second caller is refused before it starts Pi or writes an ask record. A one-shot start ticket fences
each launch: the child renames the ticket to a marker whose name carries its process ID, and `exec`
keeps that ID for Pi. A caller that abandons a launch cancels the ticket and releases its claim only
when the rename proves no Pi can run, or when the kernel reports the marker's process gone.
`running` and `unknown` keep the claim and the marker. The caller stops a taken child by process ID
with `SIGTERM` and then `SIGKILL`, within one absolute 10 second deadline. Absence from `hc` no
longer releases a claim, deletes a marker, or refuses a start. A sweep deletes a started marker
whose process is gone, even when its finished terminal was removed, and otherwise refuses with the
process ID. A `.started` name without a valid process ID refuses with the marker path. After the
architect takes the claim over, it renames its marker to an `.adopted` name and keeps it. The sweep
deletes an adopted marker only when its process is gone, and leaves a running or unknown one without
refusing a later start. An architect that took the claim keeps its process ID in the start folder,
so the lead still settles a hidden ask whose Pi stopped without its shutdown handler. Hidden ask
records change only while they are `running`, under the per-ask lock, so `sent`, `timeout`, and
`failed` are final. The lead reports `timeout` and `sent` from the locked record after its wait. A
hidden ask enforces its own deadline, and a reader repairs a running ask whose recorded terminal has
ended.
