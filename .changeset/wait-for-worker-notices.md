---
'tau': patch
---

Stop the parent from sleeping while it waits for a worker. A worker notice arrives only after the
current tool call finishes, so a long `sleep` held it back. The `subagent` tool now tells the parent
to end its turn instead. While the session has an active worker, bash commands that sleep for 30
seconds or longer are rejected.
