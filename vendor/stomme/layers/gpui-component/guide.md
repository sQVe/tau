# gpui-component guide

Apply these rules with the [GPUI guide](../gpui/guide.md) to every file that uses gpui-component.
They add to that guide and never loosen it. Each rule starts with its ID in the
[rules table](../../shared/rules.md).

The `kit` role comes from [ADR 0004](../../shared/adr/0004-roles-languages-and-layers.md). A
project maps it to a path in the `[roles]` table of `stomme.toml`.

- `gpui-component-kit`: Only the `kit` role imports gpui-component. Other code uses the project's
  own types for widgets, themes, and events, and the `kit` role translates between them and
  component types. GPUI layout and rendering types may be used throughout the `ui` role. A switch
  to a fork or another component library then changes the `kit` role only. The check is partial:
  it sees direct dependencies only, not components reached through a bundle crate such as
  `gpui-kit`.
