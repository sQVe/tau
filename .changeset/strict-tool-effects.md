---
'tau': minor
---

Refuse a launch whose started Pi process was given another model than the request. `handover`
`start` and `architect` `open` read the started process's arguments and return the `model` those
arguments name as `provider/model-id`, or `default` when they name none; `architect` `open` reports
`unknown` when the launch reported no terminal. Every registered tool now rejects an undeclared
argument, and `bash` blocks a detached command that sends its stderr to `/dev/null`.
