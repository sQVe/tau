---
'tau': patch
---

A session that waits on a tool uses far less CPU. Tau removes the spinner from Pi's loaders, so each
loader shows only its message instead of redrawing the screen on every spinner frame. When the
editor border has room only for the indicator, it shows a still dot. The status bar reuses its
session cost and context usage between frames, and its cost now includes Pi's cache-warming usage.
The subagent widget reuses its lines within the same second and width.
