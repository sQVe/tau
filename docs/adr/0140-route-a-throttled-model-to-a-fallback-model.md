# ADR 0140: Route a throttled model to a fallback model

**Date**: 2026-11-18\
**Status**: Accepted

## Context

Morph throttles DeepSeek V4.1 Flash with HTTP 429 `Service temporarily overloaded` in short
episodes. Pi retries a failed request with exponential backoff and stops after `retry.maxRetries`. A
session that runs out of retries stops, and a stopped worker hands back no report.

Pi calls the router before each retry but not after the last one, and it passes no attempt number. A
switch to another model must therefore happen inside Pi's retry budget and be counted by the router
itself. Pi sets `request.previous` from the latest successful response, so the router can tell which
model answered last.

## Decision

Tau registers one virtual model `tau/<name>` for each `fallbackModels` entry in the user file, and a
pure rule routes every request to the entry's primary or fallback model.

### The routing rule

- A user request goes to the primary and clears the retry count. It writes state only when the saved
  state differs from the reset state.
- A retry counts consecutive retries. Below the configured retry it stays on the primary; from that
  retry on it goes to the fallback and stays there.
- The router counts the request reason that Pi passes and never reads the error text. Only Pi
  matches the error text to decide whether to retry. Any request that Pi passes as a retry counts,
  including the retry after a context overflow recovery.
- A continuation keeps the current target and clears the retry count.
- A direct request goes to the fallback only when `request.previous` is the fallback. Otherwise it
  goes to the primary, also when there is no previous response. Pi passes no router state with a
  direct request.

The router state holds a format version, the consecutive retry count, and whether it is on the
fallback. It is saved on the session branch. A state of another version or shape counts as no state,
so routing starts on the primary. A router reset is routine and reports nothing.

This silent reset is a narrow exception to the diagnostic rule of
[ADR 0053](0053-version-each-saved-record-format.md). Route state only steers one request, the next
user message rebuilds it, and a reset never stops the request. Every other saved record keeps the
ADR 0053 diagnostics.

### Models come from the user config

The user file names the primary and the fallback, so Tau source names no provider or model. A
repository file cannot set `fallbackModels`; a repository that does is an error and supplies no
models. A name starts with a lower-case letter or digit. The primary and the fallback must be
physical models, not another `tau/<name>`, because Pi fails a route to a virtual model.

Each selection path checks `allowedModels`, when set, against its own model:

- The router checks the physical model it picks, so the list must hold the primary and the fallback.
- A Tau worker launch checks the selected model, so the list must hold `tau/<name>` for a worker.
- Pi's `--model` and `enabledModels` scope Pi's own selection apart from `allowedModels`. When
  `enabledModels` is set, it must list `tau/<name>`.

## Consequences

### Positive

- A throttle episode switches models at the configured retry and switches back at the next user
  message, so a session changes models at most twice per throttled user message.
- A switch spends the remaining retries on the fallback instead of the throttled primary. A session
  can still stop when both models fail through Pi's last retry.
- Tau names no provider or model, so the user can change the pair without a Tau change.
- The routing rule is a pure function with a decision table, so its retry and state cases are
  checked without a session.

### Negative

- Each switch, and each direct request that goes to the other model, can miss the prompt cache. Tau
  does not measure or bound that cost.
- A fallback outside `allowedModels` fails the request instead of routing to another model.
- Any retry that Pi passes counts toward the switch, including the retry after a context overflow
  recovery, so a switch can follow failures that are not a throttle.

## Alternatives considered

### Retry longer and stop there

Raise Pi's `retry.maxRetries` and accept the stop when the throttle lasts longer. Rejected because a
stopped worker hands back no report, and the recorded episodes include one that outlived Pi's
default retry budget.

### Rewrite the error text to avoid retries

Shorten or hide the error text in a `message_end` handler. Rejected because Pi matches that text to
decide whether to retry, so a rewrite could stop retries.

### Pick the model inside Pi

Teach Pi to switch models on an overload error. Deferred because Pi owns retry policy, and Tau can
supply a virtual model without a Pi change.
