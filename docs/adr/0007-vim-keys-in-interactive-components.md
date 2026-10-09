# ADR 0007: Vim keys in interactive components

**Date**: 2026-09-08\
**Status**: Accepted\
**Related**: [ADR 0001 (Application structure)](./0001-application-structure.md),
[ADR 0003 (Stability of externally observable identifiers)](./0003-externally-observable-identifiers.md)

[ADR 0024](./0024-commit-without-human-approval.md) removed the commit overlay and its tests. The
`SelectList` adapter described below was removed with the follow-up cleanup. Those details record
the original decision; the navigation rule still applies to remaining components.

## Context

Tau draws two interactive components: the snippet menu with its preview pane, and the commit overlay
with its choice list and comment review report. Each component read its own keys, and moved on arrow
keys, `home`, and `end` only. With no rule, each new component invented its own keys.

An extension can read Pi's bindings but cannot register a binding that Pi lists in help or lets
users rebind.

Pi's `SelectList` reads input itself and keeps `selectedIndex` private. It has no binding for
jumping to either end.

## Decision

Every interactive component in Tau accepts vim navigation keys, alongside the keys it already
accepted. Tau carries the keys and applies them to every component, so every component gets the same
keys, and users configure nothing.

### The bindings

| Key | Action                |
| --- | --------------------- |
| `j` | Down, or scroll down  |
| `k` | Up, or scroll up      |
| `g` | Jump to the first row |
| `G` | Jump to the last row  |

The arrow keys, `home`, and `end` keep working. `esc` cancels. A component that navigates at all
accepts all four keys, so users do not have to remember which component supports which keys.

Match a shifted letter with `Key.shift('g')` rather than comparing the raw byte. `matchesKey`
resolves the plain byte, the `modifyOtherKeys` form, and the Kitty form; a raw comparison only
matches the first. Pi falls back to `modifyOtherKeys` when it cannot detect the Kitty protocol.

### Where the keys live

Key predicates live in [`src/keys.ts`](../../src/keys.ts), a primitive under the rule
[ADR 0001](./0001-application-structure.md) sets for code that two or more extensions share.
Components ask `isUp`, `isDown`, `isTop`, and `isBottom` rather than testing keys themselves, so a
change to the set reaches every component.

Pi's `SelectList` cannot be driven directly, so `toCursorKey` rewrites `j` and `k` as the arrow
sequences it reads, and callers set the ends through its `setSelectedIndex`.

### Letters stay free for navigation

A component that gives single letters to actions may not use `j`, `k`, `g`, or `G` for them. The
commit overlay's Skip action moved from `k` to `x` for this reason. A letter that means "up" in one
component and an action in another is worse than an unfamiliar letter.

The same applies to typed text. A component that filters by text, such as the snippet menu, takes
the query only after the user presses `/`. Enter and `esc` end the query and return the letters to
navigation. A query field that always listens would take `j`, `k`, `g`, and `G` as text.

### What this decision does not cover

No half-page scrolling on `ctrl+d` and `ctrl+u`: `ctrl+d` is Pi's exit binding. No `q` to quit: a
single letter that aborts a commit is too easy to press by accident, and `esc` already cancels
everywhere. Both could be added, but familiarity alone is not enough reason.

## Consequences

### Positive

- One rule covers every component Tau draws now and every component it adds later.
- Users get vim keys without configuring anything.

### Negative

- The bindings do not appear in Pi's help and users cannot rebind them. Pi accepts no new binding
  identifiers from an extension. A user who wants different keys has to change Tau.
- Action letters compete with navigation letters, and navigation wins. Moving `k` to `x` changed a
  shortcut that users had already learned.
- Driving `SelectList` through rewritten input depends on the escape sequences it reads. A Pi
  release that changes them breaks navigation without an error. The original overlay tests covered
  this.

## Alternatives considered

### Each component chooses its keys

Leave each component to choose its keys. Rejected because, although it costs nothing now, keys
become less consistent as components are added.

### Users rebind Pi's bindings

Ask users to rebind Pi's own bindings, such as `tui.select.up`, in their settings. Rejected because
this covers Pi's components but not the parts of Tau that read input directly. Every user must
repeat the same configuration.

### Follow Pi's bindings

Read Pi's bindings and follow whatever the user set. Rejected because, although Tau then matches Pi,
arrow keys stay the default. Users must configure vim keys themselves.
