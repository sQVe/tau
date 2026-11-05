# ADR 0128: Support Linux and macOS only

**Date**: 2026-11-05\
**Status**: Accepted

## Context

Tau depends on tools that run only on Unix-like systems: herdr, `hc`, Pi terminals, bash, Grove, and
`gh stack`. Tau cannot do its work on Windows without them.

Windows branches still cost code and tests. Each `process.platform === 'win32'` check adds a path
that no test environment runs and no user can reach.

Tau is installed as a Pi package. People outside the repository can try to install it on Windows, so
the limit must be stated where they look.

## Decision

Tau supports Linux and macOS, and does not support Windows.

- Code has no `process.platform === 'win32'` branches.
- Code uses Unix signals such as `SIGHUP` directly, without a platform guard.
- The package states the limit: `package.json` excludes `win32` in its `os` field, and the README
  names the supported platforms.
- Guards that protect every platform stay, such as rejecting backslashes in paths and parsing CRLF
  line endings.

## Consequences

### Positive

- Code and tests carry no paths for a platform where Tau cannot run.
- A Windows user learns at install time that the package does not support their platform.

### Negative

- Supporting Windows later means adding platform paths back, and replacing the Unix-only tools Tau
  depends on.

## Alternatives considered

### Keep the existing Windows guards without promising support

Leave the `win32` checks in place but state no support. Rejected because the guards cost code and
tests, suggest a support that does not exist, and cannot make Tau run while its tools are Unix-only.
