# ADR 0142: Redact environment values in tool results

**Date**: 2026-11-19\
**Status**: Accepted\
**Related**: [ADR 0109 (Keep action behavior out of extension roots)](./0109-keep-action-behavior-out-of-extension-roots.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

A bash command such as `env` or `printenv` prints provider API keys from the process environment. Pi
saves that output in the session and sends it to the model. The key then sits in a saved file and in
a provider log.

Tau cannot remove the keys from `process.env`. Tools such as codemode's `models.classify` need them.
Output reaches the model in many forms, so a filter on the command is not enough.

## Decision

Replace the value of every secret environment variable with `[redacted]` in each tool result, in the
first `tool_result` handler that Tau registers.

A name is secret when its last `_` segment is `KEY`, `APIKEY`, `TOKEN`, `SECRET`, `PASSWORD`, or
`PASSWD`, or when it is `AWS_BEARER_TOKEN_BEDROCK`. Names that hold a file path are not secret. The
handler reads `process.env` on each call and skips values shorter than 8 characters. The handler
matches each value as a literal string and in the form that `JSON.stringify` writes. This covers
output such as `NAME=value`, `set` quoting, a script that prints one variable, and
`JSON.stringify(process.env)`. Workers do not load `src/tau.ts`, so each worker loads the same
extension with `-e` before its bash guard. When redaction throws, the handler withholds the result's
content, details, and structured content, because Pi keeps the raw result when a handler throws.

## Consequences

### Positive

- One check covers every tool, including codemode calls to other tools.
- `process.env` stays unchanged, so tools that need the keys keep working.

### Negative

- A secret that is short or has an unlisted name stays visible.
- A value in any other escape form, such as `\u` escapes, stays visible.
- Extensions that Pi loads before Tau can see the raw result.
- Live partial output and the full-output file that Pi's bash tool writes are not redacted.

## Alternatives considered

### Match a line pattern for `NAME=value`

Redact lines that look like `NAME=value`. Rejected because `set` quotes values and JSON output uses
another form, so the pattern misses real output.

### Block commands that print the environment

Refuse `env` and `printenv`. Rejected because a script or a program can print the environment
without these commands.

### Read Pi's auth store

Also redact the keys saved in Pi's `auth.json`. Deferred because the environment holds the keys that
leaked, and the store needs its own reader.
