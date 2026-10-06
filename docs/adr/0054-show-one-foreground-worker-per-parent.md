# ADR 0054: Show one foreground worker per parent

**Date**: 2026-09-27\
**Status**: Accepted\
**Supersedes**: the placement rule in
[ADR 0043 (Own only the worker guarantees herdr lacks)](./0043-own-only-the-worker-guarantees-herdr-lacks.md)

## Context

Every launch defaulted to foreground. Foreground workers split the parent tab until panes became too
small, and some sessions had up to 6 visible at once.

Most reviewer launches used the foreground default, but the parent reads their report, not their
pane. Agents pass `foreground` out of habit, in almost half of Pi worker launches. An explicit value
does not show that the user asked for a pane. Users ask for one worker pane at a time, usually the
editing worker.

## Decision

Show at most one foreground worker per parent, and choose the default visibility from the profile
role.

### Default

Editing profiles default to foreground. Investigation profiles default to background.

### Limit

While a parent's foreground worker pane is in the parent tab, every further launch runs in the
background worker tab, including an explicit `foreground` request. The slot stays taken while herdr
lists that pane there, even after cleanup could not close it. The limit counts only the parent's own
worker, so it is per parent, not per tab.

### Placement

Keep [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md) placement rules, with two
changes. The limit is a third reason to use a background tab, after a zoomed or too small parent
pane. A foreground worker splits beside the parent when that leaves both panes useful.

### Result

The launch result reports the visibility used. When a foreground request lands in the background, it
also reports why, so the parent does not tell the user a worker is beside them when it is not.

## Consequences

### Positive

- The user sees the editing worker and not the reports the parent reads.
- The parent tab keeps two readable panes instead of several narrow ones.

### Negative

- No request can show two workers beside one parent. The user can close the visible worker first.
- Several parents in one tab can each show one worker.
- A background worker stays in the background after the foreground worker ends. Herdr cannot move a
  pane between tabs without disturbing the layout.
- After the parent reloads, live workers are not counted, so the next foreground launch can add a
  second visible pane.

## Alternatives considered

### Keep the parent's choice

Keep the parent's choice and document when to use each visibility. Rejected because agents already
ignore the existing description, and nothing stops panes from piling up across turns.

### Let an explicit `foreground` exceed the limit

Let an explicit `foreground` exceed the limit. Rejected because most explicit values are habit, so
the limit would rarely apply.

### Count worker panes in the tab through herdr

Count worker panes in the tab through herdr. Rejected because, although this also limits several
parents sharing one tab, it adds herdr reads to every placement for a case the logs do not show.
