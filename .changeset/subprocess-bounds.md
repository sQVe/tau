---
'tau': patch
---

Bound Tau's subprocess waits. Each `ps` probe times out after 2000 ms, and a synchronous `ps` launch
failure counts as a failed read. A process group that still runs 2000 ms after SIGKILL is reported
as unconfirmed; `execInGroup` still waits for the group to close, including after a child error, and
adds the did-not-stop line to stderr. `execInGroup` and `hc connect` keep at most 1,048,576
characters of output, and `hc connect` keeps the first 4096 characters of stderr. `hc connect`
reports a stdout overflow even when the command exits nonzero or an earlier write failed, but a
recorded abort survives a later overflow, detaches its handlers, and destroys its pipes when it
settles. `runGit` arms each escalation timer before signaling, sends SIGTERM at its deadline,
SIGKILL 5000 ms later, and settles 2000 ms after SIGKILL, destroying its output pipes then. An abort
or buffer-limit error keeps its own reason, and a late abort without a native abort error still
reports the timeout.
