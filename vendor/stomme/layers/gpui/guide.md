# GPUI guide

Apply these rules with the [Rust coding guide](../../languages/rust/guide.md) to every file that
uses GPUI. They add to the Rust guide and never loosen it. Each rule starts with its ID in the
[rules table](../../shared/rules.md).

## Roles

The roles come from [ADR 0004](../../shared/adr/0004-roles-languages-and-layers.md). A project maps
them to paths in the `[roles]` table of `stomme.toml`.

- `gpui-plain-core`: The `core` and `cli` role packages depend on no GPUI package and no `ui`,
  `kit`, or `app` role package, directly or through other packages. They use plain project data.
- `gpui-app-lifetime`: One module of the `app` role owns the GPUI application, its windows, action
  and key registration, background tasks, and shutdown. The entry point composes dependencies and
  starts that module. Every exit path, such as quit, the last window closing, or a system quit
  request, runs the same shutdown path once.

## Names

- `gpui-context-names`: Name a GPUI context `cx` and a GPUI window `window`. Put `window` before
  `cx` in a parameter list. These names are exceptions to the full-word naming rule.

## Elements

- `gpui-builder-chain`: Write an element builder as one fluent chain, with `.when(...)`,
  `.when_some(...)`, and `.child(...)` for conditional and nested parts. Use `.when_some(...)` for
  an optional child.
- `gpui-builder-size`: Do not split a builder chain only to meet the size review signals of
  [ADR 0009](../../shared/adr/0009-advisory-review-signals.md).
- `gpui-element-id`: Build element IDs from stable domain data, such as a record's ID. Never use a
  list index as an ID.

## Entities and rendering

- `gpui-update-closure`: Inside `entity.update(cx, |state, cx| ...)`, use the closure's `state` for
  the entity's data and the closure's `cx` for GPUI calls.
- `gpui-reentrant-update`: Never read or update an entity through its handle while that entity is
  being updated. GPUI panics when you do.
- `gpui-weak-parent`: Give a child that refers to its parent a `WeakEntity`, never an `Entity`.
  Treat a failed `upgrade()` as normal: the parent is gone.
- `gpui-pure-render`: Keep `render` declarative: read state, derive values, and build elements. Do
  not start work, subscribe, or change state in `render`.
- `gpui-notify`: Call `cx.notify()` once after a change to what the view shows. Never call it from
  `render`.

## Tasks and subscriptions

- `gpui-task-owner`: Await a `Task`, store it in its owner, or call `.detach()` on purpose. Dropping
  a `Task` cancels its work. Detaching gives up both cancellation and the result.
- `gpui-subscription-owner`: Store a `Subscription` in its owner, or call `.detach()` on purpose.
  Dropping a `Subscription` ends it.
- `gpui-no-discard-binding`: Never write `let _ =` on a `Task` or `Subscription`. `_` drops it at
  once, and `let _task = ...` keeps it only to the end of the scope.
- `gpui-stale-result`: When background work finishes, check that the state it started from is still
  current, such as the same selected item. Drop the result when it is not.

## Clippy bans

- `gpui-required-ban`: Keep each GPUI `disallowed-methods` ban that stomme requires in
  `clippy.toml`, with its reason. Add your own bans next to them.
