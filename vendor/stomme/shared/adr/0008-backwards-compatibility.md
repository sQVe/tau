# ADR 0008: Drop backwards compatibility by default

**Date**: 2026-11-15\
**Status**: Accepted

## Context

Agents add backwards compatibility without being asked: a deprecated alias next to a renamed
function, an optional parameter for the old call shape, or a branch that still reads an old config
key. When every caller is in the repository, these paths serve no one, and nobody removes them later.

Some surfaces have users the agent cannot see. Users type commands and write config files, other
programs use published packages, and one version of a program reads data that another version saved.
Deleting the old path on these surfaces breaks something outside the checkout.

A strict reader rejects fields it does not know, so an older program fails on a record that a newer
one saved. Without a format version, the reader cannot tell a newer record from a broken one.

## Decision

When an interface changes, update its callers in the repository and delete the old path. Ask first
when something outside the repository may use the old surface, and version each saved format that
the program reads back.

### Delete the old path

Keep no deprecated aliases, parameters for the old call shape, branches for old config keys, or
re-exports of moved symbols. The rule covers the interface the change touches. When deleting the old
path is outside the task, say so instead of keeping both paths.

### Ask when an outside user may exist

Before changing a surface that something outside the repository may use, ask the user. The question
is who uses the surface, not where the code lives: a published package, API, or command line tool, a
config file users own, or data an earlier version saved. A package in the repository with outside
users still counts as published.

A project decision that already settles compatibility, such as the saved-format rules below, applies
without asking.

### Version each saved format

- A saved file is a record when the program parses it again, in this run or a later one. A write-only
  diagnostic file that no code reads back needs no version.
- Each record format has its own version in a `version` field. The version names the format only,
  never another value the reader can derive.
- Any change to the saved fields changes the version, including a new optional field.
- Readers stay strict and reject unknown fields.
- A reader sorts each record by version as current, previous and supported, retired, or newer. It
  reads the first two, and skips the others with a notice that names the fix.
- A record that claims a known version but fails its schema is malformed. The reader reports it, and
  no unreadable record stops an operation that does not need it.
- A change to a record writer keeps frozen fixture files for each supported version. Tests read the
  previous and current fixtures, and check that newer and malformed fixtures are skipped without
  hiding other records.

## Consequences

### Positive

- Internal renames leave no dead paths.
- Outside users are not broken silently, and the agent does not guess in either direction.
- A newer record cannot break unrelated work in an older program, and its notice names the fix.

### Negative

- Agents may ask about surfaces that have no outside users, such as internal caches.
- An instruction cannot stop an agent from claiming that an outside user might exist.
- Every format change drops that record type from older programs, even when it only adds a field.

## Alternatives considered

### Keep compatibility by default

Keep the old path on every change. Rejected because, although it protects outside users, it leaves
dead paths in every internal rename.

### Always delete the old path

Delete the old path even on published surfaces. Rejected because it breaks outside users without
warning.

### Strict readers without a version

Keep strict readers with no format version. Rejected because a reader cannot tell a newer record from
a broken one, so it can only report a failure with no fix.

### Accept unknown fields

Let readers ignore fields they do not know. Rejected because old readers would read records whose
meaning changed, and act on them.
