# React guide

Apply these rules with the [TypeScript coding guide](../../languages/typescript/guide.md) to every
file of a React project. They add to that guide and never loosen it. Each rule starts with its ID
in the [rules table](../../shared/rules.md).

## Components

- `react-jsx-extension`: Use `.tsx` only for a file that contains JSX. A file without JSX uses
  `.ts`.
- `react-component-file`: Name a file that mainly exports one component after that component, in
  PascalCase, such as `TicketList.tsx`. This treats a component like a class under the file name
  rules of [ADR 0003](../../shared/adr/0003-owner-folders-and-file-names.md).

## Test placement

This narrows the `## Test placement` section of the
[TypeScript coding guide](../../languages/typescript/guide.md#test-placement).

- `react-test-placement`: A component's unit test sits beside it as `<Component>.test.tsx` or
  `<Component><Behavior>.test.tsx`. A test that renders no JSX uses `.test.ts`.
