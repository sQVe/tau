# ADR 0007: Vim keys in interactive components

**Date**: 2026-09-08\
**Status**: Accepted\
**Related**: [ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md),
[ADR 0003 (Stability of externally observable identifiers)](./0003-externally-observable-identifiers.md)

## Context

Tau draws interactive components, such as the choice dialog and the question dialog. Each component
reads its own keys. With no rule, each new component invents its own keys.

Tau's navigation keys are literals in code, not Pi bindings. Users cannot rebind them through Pi's
settings.

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

The arrow keys, `home`, and `end` keep working. `esc` cancels the dialog. On a full preview, `esc`
closes the preview instead. A component that navigates at all accepts all four keys, so users do not
have to remember which component supports which keys.

Match a shifted letter with `Key.shift('g')` rather than comparing the raw byte. `matchesKey`
resolves the plain byte, the `modifyOtherKeys` form, and the Kitty form; a raw comparison only
matches the first. Pi falls back to `modifyOtherKeys` when it cannot detect the Kitty protocol.

### Where the keys live

Key predicates live in [`src/dialog/keys.ts`](../../src/dialog/keys.ts), in the dialog module of
[ADR 0120](./0120-capability-modules-with-an-enforced-import-table.md). Components ask `isUp`,
`isDown`, `isTop`, and `isBottom` rather than testing keys themselves, so a change to the set
reaches every component.

### Letters stay free for navigation

A component that gives single letters to actions may not use `j`, `k`, `g`, or `G` for them. A
letter that means "up" in one component and an action in another is worse than an unfamiliar letter.

The custom-answer row of the question dialog is the exception. There the four letters type text,
because a typed answer needs them as text. The option rows of the same dialog still navigate with
them.

### What this decision does not cover

No half-page scrolling on `ctrl+d` and `ctrl+u`: `ctrl+d` is Pi's exit binding. No `q` to quit: a
single letter that cancels a dialog is too easy to press by accident, and `esc` already cancels.
Both could be added, but familiarity alone is not enough reason.

## Consequences

### Positive

- One rule covers every component Tau draws now and every component it adds later.
- Users get vim keys without configuring anything.

### Negative

- Users cannot rebind these keys. A user who wants different keys has to change Tau.
- Action letters compete with navigation letters, and navigation wins.

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
