# ADR 0066: Add Tau's prompt text to Pi's append section

- Status: Accepted
- Date: 2026-09-29

## Context

Tau adds standing text to the system prompt, such as its instructions, the bare-root rule, worker
contracts, and tool guidelines. Tau used to replace the whole `systemPrompt`, and tools declared
`promptGuidelines`.

`pi-claude-bridge`, the default provider, uses Claude Code's own prompt. It forwards only Pi's
context files, skills, custom prompt, and `appendSystemPrompt`, and drops the rest without an error.
Claude models never saw Tau's text.

Pi lets `before_agent_start` change `systemPromptOptions` and recommends that over replacing the
prompt. Pi sends a direct provider a prompt change only when the rendered prompt differs from the
last one.

## Options considered

- Return a whole `systemPrompt`. Rejected: direct providers get it, but the bridge drops it.
- Set `systemPromptOptions.sections.<name>`. Rejected: Pi's docs prefer sections, but the bridge
  does not forward them, so Claude would lose the text again without an error.
- Return a `message` from `before_agent_start`, or edit the last user message in `context`.
  Rejected: both reach Claude, but they add the text to the conversation on every prompt.
- Pass worker instructions with `--append-system-prompt`. Rejected: it reaches Claude, but the flag
  replaces Pi's discovered `APPEND_SYSTEM.md`, so workers would lose the user's own appended prompt.
- Add a `contextFiles` entry. Rejected: the bridge forwards it, but Claude would read Tau's rules as
  a project file.
- Append to `systemPromptOptions.appendSystemPrompt`. Chosen: the bridge and direct providers both
  receive it.

## Decision

Tau appends every system prompt addition to `systemPromptOptions.appendSystemPrompt` in
`before_agent_start`. No Tau handler returns `systemPrompt`, sets `forceSystemPrompt`, or writes
`sections`.

- Tools do not declare `promptGuidelines`. Tau appends a tool's guidelines while the tool is active.
- A worker reads its instructions from its saved task and appends them the same way as a parent, so
  a follow-up gets them without resending.
- A turn that Tau starts while Pi is idle starts with a user message, not `triggerTurn`. An idle
  `triggerTurn` skips `before_agent_start`
  ([pi#5581](https://github.com/earendil-works/pi/issues/5581)), so the turn's prompt lacks the
  append section and the bridge fails the turn.
- Test the append section as the bridge reads it: the options object at `agent_start`.

## Tradeoffs

- Claude models through the bridge and direct providers receive the same text.
- Direct providers get each block once per session. Pi sends no prompt change while the text stays
  the same.
- Workers keep the user's `APPEND_SYSTEM.md`, and no launch argument carries the prompt.
- Cost: the bridge sends the whole append section with each Claude Code request. It is part of the
  cached system prompt, not the conversation, so it does not grow with the session.
- Cost: this depends on which fields the bridge forwards. A bridge change can drop the text again,
  so check a real `prompt_snapshot` after upgrading the bridge.

## See also

- [ADR 0062: Put worker instructions in the system prompt](./0062-put-worker-instructions-in-the-system-prompt.md)
- [elidickinson/pi-claude-bridge#135](https://github.com/elidickinson/pi-claude-bridge/issues/135)
