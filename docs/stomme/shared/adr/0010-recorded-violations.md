# ADR 0010: Recorded violations with a stale check and a growth gate

**Date**: 2026-11-16\
**Status**: Accepted\
**Related**: [ADR 0003 (Owner folders, entry files, and file names)](./0003-owner-folders-and-file-names.md)

## Context

A project can adopt the shared rules while it still breaks some of them. Requiring every break to be
fixed before the first check passes keeps the rules out of old projects. Letting the check report
only new breaks is harder: a check needs a stable identity for each break and a baseline to compare
against.

One file can break one rule more than once. A stored path and rule alone cannot tell those breaks
apart, so an entry needs a third part that names the specific break. Problems that do not carry such
an identity cannot be recorded, because one entry would hide every break of that rule in the file.

The baseline must not let the list grow without review. A stored list in the project can change in
the same commit as the code it hides, so the check compares it with the target branch the change
will merge into.

## Decision

`stomme check` reads recorded breaks from `[[violations]]` entries in `stomme.toml`. Each entry has
the required string fields `path`, `rule`, and `key`, and matches one problem when all three are
equal. An unknown rule ID, a missing or extra field, or two equal entries is a broken installation
that names the entry. Only keyed problems match an entry.

### Stale entries

On a valid installation, the check drops each problem that an entry matches. Each entry that matches
no problem produces one `violation-stale` problem at `stomme.toml`, and its message names the
entry's path, rule, and key. A fixed break therefore fails until its entry is removed.

### Growth against the target branch

When the list is not empty, the check reads `stomme.toml` from the target branch with `git` in the
project root. `check --base <ref>` names the ref. Without the flag, the check uses the
remote-tracking ref `refs/remotes/origin/<GITHUB_BASE_REF>` when `GITHUB_BASE_REF` is set and not
empty, and `refs/remotes/origin/main` otherwise. The full ref keeps a tag named `origin/<name>` from
replacing the fetched target. GitHub Actions sets `GITHUB_BASE_REF` in pull request runs. An empty
value counts as unset, because GitHub sets it to an empty string on push and schedule runs.

If the ref does not resolve, or `git` cannot run, the check reports one `violation-growth` problem
that names the ref and tells the reader to fetch it. It never skips this gate. If the target branch
has no `stomme.toml`, the project is adopting the rules and the gate reports nothing.

The check reads only the target `violations` array as `(path, rule, key)` strings. It ignores every
other field and does not validate the target installation. Invalid TOML or an entry without three
strings produces one `violation-growth` problem naming the ref. Each current entry that the target
list lacks produces one `violation-growth` problem naming the entry. This catches an added entry and
an entry the target branch removed.

An empty list never reads the target branch. A project's CI must fetch the target branch before it
runs the check. With `actions/checkout` this means `fetch-depth: 0`. A project needs no flag or
wrapper to pass the base.

## Consequences

### Positive

- A project can adopt the shared rules before it fixes every existing break.
- A new break cannot be hidden by adding an entry in the same change.
- A fixed break leaves a stale entry that fails the check, so the recorded list shrinks with the
  code.
- The entry's key keeps one recorded break from hiding another break of the same rule in the same
  file.

### Negative

- Every recorded break needs a stable key, so a rule without keys cannot have recorded breaks.
- The check needs the target branch in the local Git repository, and CI must fetch it.
- The list does not shrink automatically. Removing a fixed break's entry is a manual edit.
- The target branch's entries are read without installation validation, so a target file that is
  otherwise broken can still provide a baseline.

## Alternatives considered

### Betterer's results file and ratchet

Betterer stores test results in a committed `.betterer.results` file. Its documentation says the
results file resembles a Jest snapshot, updates when a result improves, and fails when a result gets
worse. The `--update` option force-updates it after a regression. In CI mode, Betterer fails when the
results do not exactly match the file. Its source tracks missing, changed, new, and worse results.

This was rejected because the results file stores generated issue locations and hashes for each
issue. A keyed entry here is a hand-written identity for one known break across every shared rule.
Betterer also compares with a file in the same change, while this decision compares with the target
branch so a change cannot approve its own new break.

### Goose's Clippy baseline

Goose's issue 3555 proposed a baseline for extra Clippy lints that already had hundreds of
violations. Its merged pull request 3813 added baseline files under `clippy-baselines/`, keyed by
file and function or type, plus a script that regenerates a baseline or compares the current
violations with it. CI fails when the comparison finds a new violation.

This was rejected because those baselines belong to one lint tool and one project. This decision
covers every shared rule and stores the identity in the project's `stomme.toml`. Goose regenerates
its baseline from the tool output, while this check compares the current entries with the target
branch's entries and also fails on a stale entry.
