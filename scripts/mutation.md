# Mutation testing

`scripts/mutation.ts` runs StrykerJS in the Git repository of the current directory. It needs a
Stryker config in the repository root and prints one JSON report on stdout. Stryker's own output
goes to stderr. Run it by hand; it is not part of `pnpm check`.

## Usage

```bash
node scripts/mutation.ts changed <base> [--max-mutants <n>] [--config <path>]
node scripts/mutation.ts audit <path>... [--max-mutants <n>] [--config <path>]
```

- `changed <base>` mutates the lines that `git diff -U0 <base>` adds against the working tree, and
  every line of each untracked file.
- `audit <path>...` mutates whole files.
- `--max-mutants` sets the cap. The default is 500.
- `--config` names the Stryker config. The default is `stryker.config.json` in the root.

## Setup

Another repository copies `scripts/mutation.ts`, `scripts/mutationScope.ts`,
`scripts/mutationReport.ts`, `scripts/mutationIgnorePolicy.ts`, `scripts/mutationIgnorer.ts`, and
its Stryker config. It needs the dev dependencies `@stryker-mutator/api`, `@stryker-mutator/core`, a
Stryker test runner such as `@stryker-mutator/vitest-runner`, `@stryker-mutator/instrumenter`, and
`@stryker-mutator/util`.

The config must have a non-empty `mutate` list. The script exits 1 with an error that names the
config when it is missing. The script sets `thresholds.break` to `null`, so the report alone decides
the exit code.

A file counts as production code when its path matches the config's `mutate` globs, with `!` globs
subtracted. The script replaces `mutate` with the computed ranges and writes the JSON report to a
temporary directory. The config picks the test runner and tests.

## Ignored mutants

`scripts/mutationIgnorer.ts` is a Stryker ignore plugin. It skips the string mutants of:

- the message of a built-in error: argument 0 of `Error`, `TypeError`, `RangeError`, `SyntaxError`,
  `ReferenceError`, `EvalError`, or `URIError`, and argument 1 of `AggregateError`;
- argument 0 of `new X(...)` when `X` ends in `Error` and the call has exactly one argument;
- an argument after the first of `invariant(...)`;
- the `error` value of an object literal that also has `ok: false`.

The config turns it on with two keys. `plugins` lists the test runner and
`./scripts/mutationIgnorer.ts`, and `ignorers` lists `tauMessageIgnorer`. It also sets
`"ignoreStatic": true`. Stryker resolves the plugin path from the repository root. The cap counts
with the same ignorer when `ignorers` names it.

To mark a mutant that no test can tell apart from the original, write
`// Stryker disable next-line <mutator>: <reason>` above the line.

## Cap

Before the run, the script counts the mutants of each file in scope with the Stryker instrumenter.
Ignored mutants do not count. Files get their budget in path order. A file that does not fit is not
mutated and is listed in `unmutated`. Later files that fit still run. After the run, a file that had
mutants in the count but none in Stryker's report is also listed in `unmutated`. The exit code is 1
in both modes when any file is unmutated.

## Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | `pass`, `nothing`, or survivors in `audit` mode                           |
| 2    | `survivors` in `changed` mode                                             |
| 1    | `error`: usage, Stryker failure, unmutated files, or only invalid mutants |

## Report

```json
{
  "version": 1,
  "mode": "changed",
  "status": "survivors",
  "error": "only with status error",
  "survivors": [
    {
      "file": "src/a.ts",
      "line": 3,
      "column": 7,
      "mutator": "Regex",
      "original": "/a+/",
      "replacement": "/a/",
      "covered": true
    }
  ],
  "falseSurvivors": [],
  "unmutated": ["src/b.ts"],
  "totals": {
    "mutants": 10,
    "killed": 8,
    "survived": 1,
    "noCoverage": 1,
    "timeout": 0,
    "invalid": 0,
    "falseSurvived": 0
  }
}
```

- `mode` is `null` when the command line named none.
- `status` is `pass`, `survivors`, `nothing`, or `error`. `nothing` means no production line or no
  mutant was in scope.
- Survivors are `Survived` and `NoCoverage` mutants. `covered` is false for `NoCoverage`.
- `totals.invalid` counts `CompileError` and `RuntimeError` mutants. When every mutant is invalid,
  the status is `error`.
- A false survivor is a static mutant that Stryker marks `Survived` although fewer tests completed
  than the report holds. The mutant made a test file throw while Vitest loaded it, so no test in
  that file ran. `falseSurvivors` lists them in the shape of `survivors`. They are not in
  `survivors` or `totals.survived`, and they do not change the status.
