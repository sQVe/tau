---
'tau': minor
---

New `full_check` tool. Set a repository's full-check command as
`fullCheck.repositories.<owner/name>.argv` in `~/.pi/agent/tau.json`. Full checks on one machine
then run one at a time across repositories, and a check that waits says so. A passing log is reused
while the head, base, command, and uncommitted changes stay the same. Workers and the `tdd`,
`fix-bug`, and `pr` skills use the tool when a command is set, and run the check as before
otherwise.
