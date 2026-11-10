# ADR 0131: Load language rules on first file access

**Date**: 2026-11-10\
**Status**: Accepted\
**Related**: [ADR 0066 (Add Tau's prompt text to Pi's append section)](./0066-add-taus-prompt-text-to-pis-append-section.md),
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md)

## Context

Language rules do not belong in every session's prompt. A repository can contain several languages,
and a session may never use its TypeScript files. Startup detection would load rules before an agent
needs them.

A tool call can be the first evidence of language use. That model request cannot have considered
rules delivered after it began. In the controlled Pi test, a sibling write changed the file before
the first-touch gate was added. Sending rules alone would leave that change unchecked.

Nested codemode reads can discard their output. Tool results also carry structured content that a
text replacement must not lose. Neither path is a reliable place for standing instructions.

## Decision

Load language rules on the first relevant file access, deliver them separately, and refuse changes
from requests that have not received them.

The file extension selects the rules. Dependency files and declaration files do not activate
TypeScript rules because inspecting them does not imply work on the repository's TypeScript source.
A separate custom message reaches the next model request even when a nested read returns no output.
Later runs use the append section, so direct providers and the bridge receive the same rules.

The gate tracks what the current model request received, not only whether the session is active.
This keeps sibling changes from passing just because an earlier call activated the rules. A refused
change asks the agent to reconsider and retry. The cost is one retry when the first change already
follows the rules.

Activation belongs to the current session branch and uses a versioned entry. Managers and workers
share the same behavior because both can access source files. An explicit command covers work done
only through shell commands or generators, which file-tool hooks cannot observe.

## Consequences

### Positive

- Sessions that do not access a language's files carry none of its rule text.
- Read results retain their content and structured content.
- Reloading or resuming an active branch does not lose the rules.

### Negative

- The first change may need a retry even when it follows the rules.
- Shell-only work depends on explicit activation.
- Compaction can remove the first-touch message, so an active run may need another message.

## Alternatives considered

### Load every language rule by default

Rejected because unrelated sessions would carry language-specific text they do not use.

### Detect a TypeScript configuration at startup

Rejected because a configuration file says nothing about which files this session will touch.

### Append rules to the first read result

Rejected because nested scripts may discard that result, and replacing its content risks losing
structured content.

### Deliver rules without a change gate

Rejected because sibling edits and writes come from the same uninformed request. Delivery before the
next request cannot change decisions the model already made.
