# ADR 0079: Grow modules from flat files

- Status: Accepted
- Date: 2026-10-01
- Supersedes: the layout, skills location, extension shape, and primitive shape in
  [ADR 0001](./0001-application-structure.md), and the `index.ts` rule in
  [ADR 0002](./0002-file-naming-conventions.md)

## Context

- ADR 0001 gave every module a folder with `index.ts`. 13 of the 24 module folders under `src/` held
  one source file, so the folder added a path segment and nothing else.
- Many files named `index.ts` look the same in editor tabs, search results, and stack traces.
- Pi loads a package folder through its `index.ts`. A folder without one loads every `.ts` file in
  it, tests included. The package entry must therefore be a named file.
- Instruction files lived in extension folders, which kept three one-file extensions as folders.
- ADR 0001 kept skills at the package root for Pi's discovery. Pi reads the skills path from
  `package.json`, so any folder works.
- Gremlin's ADR 0004, "Capability modules with an enforced import table", adopted the same
  flat-first rule.

## Options considered

- Keep a folder with `index.ts` for every module. Rejected: most folders hold one file, and the
  names do not say which module a file belongs to.
- Keep folders, but name the entry after the folder. Rejected: it fixes the names and keeps the
  empty folders.
- Start each module as a flat file and turn it into a folder at its second source file. Chosen: the
  path shows the module's size, and every file name says what it holds.
- Keep skills and instruction files at the package root. Rejected: what the package ships would live
  in several places, and Pi does not require the root.
- Copy Gremlin's import table. Rejected: Tau's modules are extensions and shared code, and the
  existing extension boundary rule already sets the direction.

## Decision

Everything the package ships lives in `src/`. A module is a flat file until it has two production
source files. Then it becomes a folder whose entry file is named after the folder. `src/` has no
`index.*` files.

```text
tau/
  src/
    tau.ts                 # package entry; installs every extension
    instructions/          # instruction sets, read at runtime
      <setName>.md
    skills/                # declared in package.json
      <skillName>/
        SKILL.md
    <shared>.ts            # shared module with one source file
    <shared>/              # shared module with two or more source files
      <shared>.ts          # entry
    extensions/
      <extension>.ts
      <extension>/
        <extension>.ts     # entry
```

### Modules

- Count production source files only. Tests, `fixtures/`, and runtime assets such as `profiles/` and
  `snippets/` do not count.
- A flat module keeps its test beside it, such as `src/keys.ts` and `src/keys.test.ts`.
- When a flat module needs a second source file, move it into a folder of the same name and keep the
  name for the entry file.
- `src/extensions/`, `src/skills/`, `src/instructions/`, `fixtures/`, `profiles/`, and `snippets/`
  group files. They are not modules and have no entry file.
- `package.json` points `pi.extensions` at `./src/tau.ts`, a file, so Pi never scans a folder. It
  points `pi.skills` at `./src/skills`.
- Skill folder names stay public identifiers under
  [ADR 0003](./0003-externally-observable-identifiers.md); moving the parent folder does not rename
  them.

### Private files

- Other modules import a folder module through its entry file. The module's other files are private.
- A folder module may name extra public files when other modules already depend on them, such as
  `controller.ts`, `record.ts`, and `budget.ts` in `subagents/controller/`. Do not add barrel files.
- Tests in `tests/` and fixtures may import private files.
- Do not add new shared `types.ts` files.

### Enforcement

- Checks refuse `index.*` files under `src/`, folders with one production source file, and imports
  of another module's private files.
- The extension boundary rule and the shared-module guard cover flat files as well as folders.

## Tradeoffs

- The path shows how large a module is, and each file name says which module it belongs to.
- Pi loads exactly one file, so a stray test file in a folder cannot become an extension.
- Everything the package ships sits under one folder, so one path filter covers it.
- Cost: relative links between skills, instructions, and docs change with the extra folder level.
- Cost: a module's second file moves its first file, which touches every import of it.
- Cost: file names repeat their folder, as in `src/extensions/commit/commit.ts`.
- Cost: other worktrees that change `src/` must rebase over the moves.

## See also

- [ADR 0001: Application structure](./0001-application-structure.md)
- [ADR 0002: File and directory naming conventions](./0002-file-naming-conventions.md)
- [ADR 0057: Enforce pure decision modules from a registry](./0057-enforce-pure-decision-modules-from-a-registry.md)
