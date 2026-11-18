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

- A user request goes to the primary and clears the retry count.
- A retry counts consecutive retries. Below the configured retry it stays on the primary; from that
  retry on it goes to the fallback and stays there.
- A continuation keeps the current target and clears the retry count.
- A direct request goes to the model of the latest successful response, because the transcript does
  not carry router state for it.

The router state holds a format version, the consecutive retry count, and whether it is on the
fallback. It is saved on the session branch. A state of another version or shape counts as no state,
so routing starts on the primary. A router reset is routine and reports nothing.

### Models come from the user config

The user file names the primary and the fallback, so Tau source names no provider or model. A
repository file cannot set `fallbackModels`; a repository that does is an error and supplies no
models.

The router resolves each target through the allowed-model check. `allowedModels`, when set, must
list `tau/<name>`, the primary, and the fallback. Pi's `enabledModels`, when set, must list
`tau/<name>`.

## Consequences

### Positive

- A throttle episode costs one cache miss, when the session switches models, instead of a stopped
  session.
- Tau names no provider or model, so the user can change the pair without a Tau change.
- The routing rule is a pure function with a decision table, so its retry and state cases are
  checked without a session.

### Negative

- A switched session loses its prompt cache once per throttle episode.
- A fallback outside `allowedModels` fails the request instead of routing to another model.
- A retry for a context overflow counts toward the switch, so five in a row also switch models.

## Alternatives considered

### Retry longer and stop there

Raise Pi's `retry.maxRetries` and accept the stop when the throttle lasts longer. Rejected because a
stopped worker hands back no report, and the recorded episodes include one that outlived Pi's
default retry budget.

### Rewrite the error text to avoid retries

Shorten or hide the error text in a `message_end` handler. Rejected because Pi and the router both
match that text, so a rewrite could stop retries.

### Pick the model inside Pi

Teach Pi to switch models on an overload error. Deferred because Pi owns retry policy, and Tau can
supply a virtual model without a Pi change.
