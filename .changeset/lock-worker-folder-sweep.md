---
'tau': patch
---

Lock each worker folder sweep on its agent directory. The sweep now takes
`.tau-worker-folder-sweep.lock` before reading the terminal list and the folders, and holds it
through marker writes and removals. A sweep that read a snapshot as unused can no longer write that
stale marker after another manager's launch cleared it. The unused window starts after a sweep gets
the lock, so a wait never backdates a new marker. A follow-up that reuses a package snapshot waits
for the same lock before it starts, clears the snapshot's old marker, and keeps the lock through the
terminal request. It restores the old marker when the start fails definitely. Launches still start
their sweep without waiting.
