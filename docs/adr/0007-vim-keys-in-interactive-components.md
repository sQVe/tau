# ADR 0007: Vim keys in interactive components

- Status: Accepted
- Date: 2026-09-08

## Context

- Tau draws two interactive components: the snippet menu with its preview pane, and the commit
  overlay with its choice list and comment review report.
- Each component read its own keys. They moved on arrow keys, `home`, and `end` only.
- Pi's `KeybindingsManager` receives its definitions in its constructor and exposes no method for
  adding one. An extension can read pi's bindings, but cannot register a binding of its own that pi
  would list in help or let a user rebind.
- Pi's `SelectList` reads input itself and keeps `selectedIndex` private. It binds arrow keys,
  `enter`, and `escape`, and has no binding for jumping to either end.
- Component authors had no rule to follow, so each new component invented its own keys.

## Options considered

- Leave each component to choose its keys. Costs nothing now and drifts with every addition.
- Ask users to rebind pi's own bindings, such as `tui.select.up`, in their settings. This covers
  pi's components but not the parts of Tau that read input directly, and it makes every user repeat
  the same configuration.
- Read pi's bindings and follow whatever the user set. Tau then matches the surrounding app, but
  arrow keys stay the default and no user gets vim keys without configuring them.
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
accepts all four keys, so a reader never has to remember which surface supports which.

Match a shifted letter with `Key.shift('g')` rather than comparing the raw byte. `matchesKey`
resolves the plain byte, the `modifyOtherKeys` form, and the Kitty form; a raw comparison only
matches the first, and pi falls back to `modifyOtherKeys` when it cannot detect the Kitty protocol.

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

No half-page scrolling on `ctrl+d` and `ctrl+u`: `ctrl+d` is pi's exit binding. No `q` to quit: a
single letter that aborts a commit is too easy to press by accident, and `esc` already cancels
everywhere. Neither is refused on principle; both need a reason stronger than familiarity.

## Tradeoffs

- One rule covers every component Tau draws now and every component it adds later.
- Users get vim keys without configuring anything.
- Cost: the bindings do not appear in pi's help and users cannot rebind them, because pi accepts no
  new binding ids from an extension. A user who wants different keys has to change Tau.
- Cost: action letters compete with navigation letters, and navigation wins. Moving `k` to `x`
  changed a shortcut that users had already learned.
- Cost: driving `SelectList` through rewritten input depends on the escape sequences it reads. A pi
  release that changes them breaks this quietly, which the overlay tests are there to catch.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0003: Stability of externally observable identifiers](./0003-externally-observable-identifiers.md)
