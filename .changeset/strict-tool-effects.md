---
'tau': minor
---

Refuse a launch whose started Pi runs another model than the request. `handover` `start` and
`architect` `open` read the started terminal and return its `model` as `provider/model-id`, or
`default` when Pi chose; `architect` `open` reports `unknown` when the launch reported no terminal.
Every registered tool now rejects an undeclared argument, and `bash` blocks a detached command that
sends its stderr to `/dev/null`.
