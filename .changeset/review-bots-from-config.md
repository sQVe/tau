---
'tau': minor
---

`pr` requests the review bots listed under `reviews.repositories` in the user `tau.json`, on new PRs
and on updates, without asking. It skips a bot that already reviewed the head or was already asked
after the head was pushed, which it reads from the head's check suites. The `pr` tool has a
read-only `reviewBots` action that reports each bot as `request`, `reviewed`, or `requested`. With
no config entry for the repository, `pr` requests no bot, and the fixed `@codex review` comment is
gone. A change that the approved option or the user's answer already named exactly no longer needs a
new preview.
