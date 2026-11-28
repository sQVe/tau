---
'tau': minor
---

Refuse a launch whose started Pi process was given another model than the request. `handover`
`start` and `architect` `open` read the started process's arguments and report the `model` those
arguments name as `provider/model-id`, and `handover` `start` reports `default` when they name none.
A model that differs from the request, or arguments that cannot be read, refuses the launch and
names the live terminal so the caller can stop it. Every registered tool now rejects an undeclared
argument, and `bash` blocks a detached command that sends its stderr to `/dev/null` or into a
pipeline that discards it.
