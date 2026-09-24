---
'tau': patch
---

Worker startup and cleanup no longer fail when a zsh prompt hook briefly occupies the shell. herdr
now gets a start timeout below Tau's own budget and above herdr's 3000 ms minimum, so its structured
timeout error reaches the task record. A launch with too little budget left is refused before
`agent start`, and failures before any start say that no worker was started.
