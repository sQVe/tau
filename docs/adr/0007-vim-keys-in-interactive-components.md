# ADR 0007: Vim keys in interactive components

- Status: Accepted
- Date: 2026-09-08

## Context

- Tau draws two interactive components: the snippet menu with its preview pane, and the commit
  overlay with its choice list and comment review report.
- Each component read its own keys. They moved on arrow keys, `home`, and `end` only.
- Pi's `KeybindingsManager` receives binding definitions in its constructor and exposes no method
  for adding one. An extension can read Pi's bindings but cannot register a binding that Pi lists in
  help or lets users rebind.
- Pi's `SelectList` reads input itself and keeps `selectedIndex` private. It binds arrow keys,
  `enter`, and `escape`, and has no binding for jumping to either end.
- Component authors had no rule to follow, so each new component invented its own keys.

## Options considered

- Leave each component to choose its keys. Costs nothing now, but keys become less consistent as
  components are added.
- Ask users to rebind Pi's own bindings, such as `tui.select.up`, in their settings. This covers
  Pi's components but not the parts of Tau that read input directly. Every user must repeat the same
  configuration.
- Read Pi's bindings and follow whatever the user set. Tau then matches Pi, but arrow keys stay the
  default. Users must configure vim keys themselves.
- Carry the keys in Tau and apply them to every component.

## Decision

Every interactive component in Tau accepts vim navigation keys, alongside the keys it already
accepted.

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

Key predicates live in [`src/keys/`](../../src/keys/index.ts), a primitive under the rule ADR 0001
sets for code that two or more extensions share. Components ask `isUp`, `isDown`, `isTop`, and
`isBottom` rather than testing keys themselves, so a change to the set reaches every component.

Pi's `SelectList` cannot be driven directly, so `toCursorKey` rewrites `j` and `k` as the arrow
sequences it reads, and callers set the ends through its `setSelectedIndex`.

### Letters stay free for navigation

A component that gives single letters to actions may not use `j`, `k`, `g`, or `G` for them. The
commit overlay's Skip action moved from `k` to `x` for this reason. A letter that means "up" in one
component and an action in another is worse than an unfamiliar letter.

### What this decision does not cover

No half-page scrolling on `ctrl+d` and `ctrl+u`: `ctrl+d` is Pi's exit binding. No `q` to quit: a
single letter that aborts a commit is too easy to press by accident, and `esc` already cancels
everywhere. Both could be added, but familiarity alone is not enough reason.

## Tradeoffs

- One rule covers every component Tau draws now and every component it adds later.
- Users get vim keys without configuring anything.
- Cost: the bindings do not appear in Pi's help and users cannot rebind them. Pi accepts no new
  binding identifiers from an extension. A user who wants different keys has to change Tau.
- Cost: action letters compete with navigation letters, and navigation wins. Moving `k` to `x`
  changed a shortcut that users had already learned.
- Cost: driving `SelectList` through rewritten input depends on the escape sequences it reads. A Pi
  release that changes them breaks navigation without an error. The overlay tests catch this.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0003: Stability of externally observable identifiers](./0003-externally-observable-identifiers.md)
