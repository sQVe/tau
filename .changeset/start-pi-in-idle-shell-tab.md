---
'tau': patch
---

`handover start` takes over a space's idle shell tab instead of opening another tab. When the space
has one tab with one idle shell in the request's folder, Pi starts by splitting that shell's pane
and then closing the shell. The shell closes only when `hc get` still reports a shell in that folder
after the split. Every other case opens a tab as before.
