---
'tau': patch
---

Bound Tau's subprocess waits. Each `ps` probe times out after 2000 ms, and a synchronous `ps` launch
failure counts as a failed read. A process group that still runs 2000 ms after SIGKILL is reported
as unconfirmed; `execInGroup` still waits for the group to close, including after a child error, and
adds the did-not-stop line to stderr. `execInGroup` keeps at most 1,048,576 characters of stdout and
of stderr separately, so a stdout flood cannot drop a later stderr diagnostic. `hc connect` keeps at
most 1,048,576 characters of stdout and the first 4096 characters of stderr. `hc connect` reports a
stdout overflow even when the command exits nonzero or an earlier write failed, but a recorded abort
survives a later overflow, detaches its handlers, and destroys its pipes when it settles. It does
not signal a child that already exited and arms no kill or confirm timer then, so it settles on
close with a reason that does not claim SIGKILL. Its confirm window runs 2000 ms from the moment
SIGKILL is sent. A stream failure recorded before an abort stays the failure of record. `runGit`
arms each escalation timer before signaling, sends SIGTERM at its deadline, SIGKILL 5000 ms later,
and settles 2000 ms after SIGKILL, destroying its output pipes then; it arms that final fallback
only after the SIGKILL step. A refused SIGKILL reports that Git could not be stopped instead of
claiming the signal was sent. A Git that exits before the deadline or during the grace keeps its
output, a timeout of 0 means no timeout, and a negative timeout is rejected with a local message. An
abort or buffer-limit error keeps its own reason, and a late abort without a native abort error
still reports the timeout.
