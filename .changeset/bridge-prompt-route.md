---
'tau': minor
---

Deliver Tau's instructions to Claude models through `pi-claude-bridge`. Tau now adds the coding,
writing, and workflow instructions, the bare-root rule, worker instructions, and the manager,
`bulk_read`, and `commit` guidelines to Pi's `appendSystemPrompt` instead of replacing the system
prompt, which the bridge dropped. A worker notice that arrives while the parent is idle now starts
the turn with a short user message, so that turn keeps the instructions. `pnpm check` fails when the
installed `pi` differs from Tau's Pi dependency in minor version.
