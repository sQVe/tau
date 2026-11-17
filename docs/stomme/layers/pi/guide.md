# Pi guide

Apply these rules with the [TypeScript coding guide](../../languages/typescript/guide.md) to every
file of a Pi package. They add to that guide and never loosen it. Each rule starts with its ID in
the [rules table](../../shared/rules.md).

Pi finds some files by path and keeps some names in saved sessions. Users, other programs, and saved
data depend on these names, so they follow the outside-surface rules of
[ADR 0008](../../shared/adr/0008-backwards-compatibility.md).

- `pi-discovered-path`: Declare every path Pi discovers, such as an extension entry or a skills
  folder, in the `pi` field of `package.json`. Keep each discovered path and skill folder name
  unchanged when you rename code. Change one only for its own reason, with a plan for existing
  users.
- `pi-registered-name`: Keep each name registered with Pi unchanged when you rename code. This
  covers tool names, command names, event types passed to `pi.on`, and custom entry types saved in
  sessions. Matching a function name is not a reason to change one.
