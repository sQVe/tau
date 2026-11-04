# ADR 0127: Version the draft review viewer protocol

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0112 (Review collaborative drafts as files in tuicr)](./0112-review-collaborative-drafts-as-files-in-tuicr.md)

## Context

`draft_review` opens drafts in tuicr and reads the user's comments back from tuicr's own session
store. That store is tuicr's private format, so a different viewer cannot supply comments without
tuicr. The next slice moves the viewer to Koja. The review record needs a viewer contract that
outlives any one viewer.

A viewer writes files into the record directory while the agent waits. The agent must trust those
files or refuse them before it deletes a comment or writes an edit, because a wrong file could name
drafts it never showed the user.

## Decision

Each review record holds a versioned viewer protocol, and `collect` reads a viewer's reply through
it.

- `request.json` names the review ID, which is the record directory name, and the ordered file pairs
  the review staged. `open` writes it beside `review.json`.
- `comments.json` is a viewer's reply: the review ID, a state of `open`, `submitted`, or `error`
  with a reason, and comments that name a staged path with lines, type, and content.
- `collect` validates a reply before any change. A newer version, malformed JSON, another review ID,
  a file the review did not stage, or an error state refuses and keeps the record. When a fresh
  review's reply is valid, it is the only source of comments, and collect does not call tuicr for
  comments.
- `collect` reads and checks the reply again on every try. A viewer review saves no comments in
  `collected.json`, so the reply stays the source of comments and a later try sees the latest reply.
- A record that already saved tuicr comments refuses a viewer reply. Collect must return every
  comment it deletes, so it cannot switch source after deleting with tuicr.
- Both files are versions of the shared saved-record format, so a reader gets the same version and
  schema errors as other `.tau/` records.
- `src/extensions/draftReview/fixtures/viewerProtocol/` holds frozen current, newer, malformed,
  foreign-ID, path-outside, and error fixtures. A viewer project can pin them by Tau commit and test
  that it reads and writes the contract a Tau version expects.

The slice that removes tuicr supersedes
[ADR 0112](./0112-review-collaborative-drafts-as-files-in-tuicr.md).

## Consequences

### Positive

- A viewer reads and writes the contract without sharing tuicr's private store.
- A viewer can test its output against the exact fixture set of a Tau commit.
- Invalid replies are refused before collect changes a file.

### Negative

- Each new protocol version needs a fixture and a reader that refuses the old one.
- The agent carries two comment sources until the tuicr removal slice lands.

## Alternatives considered

### Keep reading comments only from tuicr

Rejected because it ties the review to one viewer's format change with every tuicr release, and
blocks Koja.

### An unversioned comments file

Rejected because a viewer and Tau would disagree silently after a format change, instead of refusing
a reply Tau does not understand.

### Put the comments in `review.json`

Rejected because the viewer writes while the agent reads the same record, and one file would let a
partially written reply corrupt the manifest that collect needs to find the drafts.

### Copy the viewer comments into `collected.json`

A new `collected.json` version would freeze the viewer comments, and a retry would read that copy.
Rejected because the viewer can write a new reply before the retry, and a frozen copy would hide it
instead of checking the reply again.

### Skip the saved tuicr deletes when a viewer reply appears

A retry would prefer the viewer reply and leave the saved tuicr comments in tuicr. Rejected because
a saved tuicr comment would stay in tuicr while collect returns only the viewer comments, so the
caller cannot tell which comments were collected.
