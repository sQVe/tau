# ADR 0066: Add Tau's prompt text to Pi's append section

- Status: Accepted
- Date: 2026-09-29

## Context

Tau adds standing text to the system prompt: the coding, writing, and workflow instructions, the
bare-root rule, a worker's profile body and contracts, and the guidelines for the manager,
`bulk_read`, and `commit` tools. Tau used to return a whole new `systemPrompt` from
`before_agent_start`, and the tools declared their guidelines as `promptGuidelines`.

`pi-claude-bridge`, the default provider, does not send Pi's system prompt to Claude Code. It uses
Claude Code's own prompt and forwards only Pi's context files, skills, custom prompt, and
`appendSystemPrompt` (`pi-claude-bridge/src/prompt-capture.ts`, version 0.9.0). A replaced prompt,
tool guidelines, and sections are dropped without an error. Claude models never saw Tau's text.

Pi 0.86 made `systemPromptOptions` in `before_agent_start` mutable and recommends structured changes
over replacing the prompt. Pi rebuilds the options for each run and sends a direct provider a prompt
change only when the rendered prompt differs from the last one.

## Options considered

- Return a whole `systemPrompt`. Direct providers get it, but the bridge drops it.
- Set `systemPromptOptions.sections.<name>`. Pi's docs prefer sections, but the bridge uses sections
  only to match prompts (`transcript.ts`) and does not forward them. Claude would lose the text
  again, without an error.
- Return a `message` from `before_agent_start`, or edit the last user message in `context`. Both
  reach Claude, but they add the text to the conversation on every prompt.
- Pass worker instructions with `--append-system-prompt`. It reaches Claude, but the flag replaces
  Pi's discovered `APPEND_SYSTEM.md`, so workers would lose the user's own appended prompt.
- Add a `contextFiles` entry. The bridge forwards it, but Claude would read Tau's rules as a project
  file.
- Append to `systemPromptOptions.appendSystemPrompt`.

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
