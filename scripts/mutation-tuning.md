# Mutation tuning note

This note records how `stryker.config.json` was tuned. It lists the sample commits, the survivors of
each commit, and the reason for each setting. The command is now the `@sqve/mutation` package; this
note describes the copy that Tau kept before.

## Method

For each commit, a detached worktree held the commit. The mutation scripts, `stryker.config.json`,
and `stryker.vitest.config.ts` were copied in. `node_modules` was a real directory of symlinks to
the packages of the main checkout. Each run was the old copy of the script with `changed <sha>^`.
The worktrees are removed. The final reports are in `.tau/mutation-tuning-reports/<sha>.json`, with
stderr and run metadata next to them. Earlier failed attempts are in
`.tau/mutation-tuning-reports/earlier/`.

The machine was under heavy load from other workspaces during the runs. The run table gives the load
average before and after each run. The five smaller commits ran at the same time. `e9696243` ran
alone in the final rerun.

Kinds:

- Real gap: a behavior no test pins.
- Equivalent: the change shows nothing a caller can observe.
- Noise: a mutant that the repository rules say not to test, such as error wording or constants.

The classification is by hand, from reading the code at the commit. "Survivors" counts `Survived`
and `NoCoverage` mutants.

## Sample commits

The ticket named `e9696243`, `23f561ec`, `735ec19b`, `e9c712b1`, and `fd5d2213`. `735ec19b` and
`e9c712b1` change only Markdown under `src/skills/`, so they have no mutant. `290ea97f`, `a242c016`,
and `cdb006a5` replace them. They are production commits on `origin/main` with mutants.

The numbers come from the rerun with the final config. The config excludes no mutator, so the
survivors include every `StringLiteral` mutant.

| Commit   | Subject                                                                                | Mutants | Killed | Survived | No coverage | Timeout | Real gap | Equivalent | Noise |
| -------- | -------------------------------------------------------------------------------------- | ------- | ------ | -------- | ----------- | ------- | -------- | ---------- | ----- |
| e9696243 | feat(review): list added test and suppression markers in review evidence (#374)        | 428     | 294    | 81       | 44          | 8       | 112      | 6          | 7     |
| 23f561ec | fix(ask-user-question): require a visible reply after a typed answer (#379)            | 143     | 124    | 17       | 2           | 0       | 11       | 6          | 2     |
| 290ea97f | feat(draft-review): open reviews in a tab when the agent pane is narrow (#377)         | 112     | 88     | 18       | 6           | 0       | 18       | 0          | 6     |
| a242c016 | fix(full-check): stop hung checks and kill orphaned Vitest forks (#369)                | 50      | 36     | 13       | 1           | 0       | 7        | 4          | 3     |
| cdb006a5 | fix(tracker): scope the duplicate search by team ID and drop the more-pages gap (#365) | 22      | 18     | 3        | 1           | 0       | 4        | 0          | 0     |
| fd5d2213 | feat(full-check): queue full checks per repository (#370)                              | 13      | 10     | 3        | 0           | 0       | 0        | 2          | 1     |

## Runs

The load average is the 1, 5, and 15 minute value from `/proc/loadavg`. A run marked SIGTERM ended
with Stryker exit status 143. The cause is unknown. The final `e9696243` run ran alone and finished.
The earlier failed attempts did not change a result: the two dry-run timeouts led to the two changed
settings below.

| Commit   | Run                                                | Load average before (1, 5, 15 min) | Load average after    | Seconds | Exit code |
| -------- | -------------------------------------------------- | ---------------------------------- | --------------------- | ------- | --------- |
| fd5d2213 | earlier: all tests, dry run timed out              | 134.44, 141.64, 106.84             | 81.17, 107.41, 103.18 | 321     | 1         |
| e9696243 | earlier: related, 5 min dry run timed out          | 85.22, 97.99, 100.23               | 76.48, 88.80, 96.12   | 321     | 1         |
| e9696243 | earlier: related, 20 min dry run, ended by SIGTERM | 63.60, 73.34, 87.52                | 41.00, 52.93, 58.55   | 1956    | 1         |
| e9696243 | final config                                       | 10.74, 16.10, 24.42                | 12.87, 16.51, 19.31   | 1362    | 2         |
| 23f561ec | final config                                       | 17.69, 21.46, 28.88                | 32.00, 24.85, 29.58   | 62      | 2         |
| 290ea97f | final config                                       | 17.69, 21.46, 28.88                | 22.84, 25.23, 29.22   | 188     | 2         |
| a242c016 | final config                                       | 17.69, 21.46, 28.88                | 30.50, 26.47, 29.81   | 134     | 2         |
| cdb006a5 | final config                                       | 17.69, 21.46, 28.88                | 25.08, 22.86, 29.18   | 21      | 2         |
| fd5d2213 | final config                                       | 17.69, 21.46, 28.88                | 34.62, 26.09, 29.87   | 85      | 2         |

## Survivors

Each entry gives the file under `src/extensions/` (or `src/`), the line, and the mutator. A survivor
counts as equivalent only when the code shows it. Otherwise it counts as a real gap. For `e9696243`
the reasons are per group of lines, not per line, because the commit has 125 survivors.

### e9696243

| Location                                                 | Mutator               | Original                                             | Replacement                                | Kind       | Reason                                                                                                   |
| -------------------------------------------------------- | --------------------- | ---------------------------------------------------- | ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------- |
| pr/evidence.ts:112                                       | CallExpression        | `evidence.gaps.push( ...scan.gaps.map((gap): Public` | `;`                                        | gap        | No test reads scan gaps or a failed marker read into the publication evidence.                           |
| pr/evidence.ts:113                                       | ArrowFunction         | `(gap): PublicationGap => ({ kind: 'reviewEvidence'` | `() => undefined`                          | gap        | No test reads scan gaps or a failed marker read into the publication evidence.                           |
| pr/evidence.ts:113 (no coverage)                         | ObjectLiteral         | `{ kind: 'reviewEvidence', gap }`                    | `{}`                                       | gap        | No test reads scan gaps or a failed marker read into the publication evidence.                           |
| pr/evidence.ts:113 (no coverage)                         | StringLiteral         | `'reviewEvidence'`                                   | `""`                                       | gap        | No test reads scan gaps or a failed marker read into the publication evidence.                           |
| pr/evidence.ts:115 (no coverage)                         | BlockStatement        | `{ evidence.gaps.push(readFailure('markers', error)` | `{}`                                       | gap        | No test reads scan gaps or a failed marker read into the publication evidence.                           |
| pr/evidence.ts:116 (no coverage)                         | StringLiteral         | `'markers'`                                          | `""`                                       | gap        | No test reads scan gaps or a failed marker read into the publication evidence.                           |
| pr/evidence.ts:279                                       | ArrayDeclaration      | `[]`                                                 | `["Stryker was here"]`                     | gap        | No test reads scan gaps or a failed marker read into the publication evidence.                           |
| src/git.ts:98                                            | OptionalChaining      | `child.stdin?.on`                                    | `child.stdin.on`                           | equivalent | Git runs with a stdin pipe here, so the optional chain never meets undefined.                            |
| src/git.ts:100                                           | ConditionalExpression | `input !== undefined`                                | `true`                                     | gap        | No test runs a command without input that reads stdin, so closing it early is not pinned.                |
| src/git.ts:101                                           | OptionalChaining      | `child.stdin?.end`                                   | `child.stdin.end`                          | equivalent | Git runs with a stdin pipe here, so the optional chain never meets undefined.                            |
| src/reviewCapture/evidenceDecisions.ts:412               | Regex                 | `/\.(?:md'mdx'markdown)$/i`                          | `/\.(?:md'mdx'markdown)/i`                 | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:414               | Regex                 | `/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/`        | `/@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @` | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:414               | Regex                 | `/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/`        | `/^@@ -\d+(?:,(\d))? \+(\d+)(?:,(\d+))? @` | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:414               | Regex                 | `/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/`        | `/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d))? @` | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:420               | MethodExpression      | `text.startsWith('"')`                               | `text.endsWith('"')`                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:420 (no coverage) | StringLiteral         | `''`                                                 | `"Stryker was here!"`                      | equivalent | `split` always returns a first element, so the fallback is never used.                                   |
| src/reviewCapture/evidenceDecisions.ts:422               | ConditionalExpression | `name === '/dev/null'`                               | `false`                                    | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:422               | StringLiteral         | `'/dev/null'`                                        | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:422               | BlockStatement        | `{ return undefined; }`                              | `{}`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:426               | StringLiteral         | `'b/'`                                               | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:431               | BlockStatement        | `{ hunk.oldRemaining = 0; hunk.newRemaining = 0; }`  | `{}`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:442               | StringLiteral         | `' '`                                                | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:444               | ConditionalExpression | `hunk.oldRemaining <= 0`                             | `true`                                     | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:444               | EqualityOperator      | `hunk.oldRemaining <= 0`                             | `hunk.oldRemaining < 0`                    | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:451               | AssignmentOperator    | `hunk.newRemaining -= 1`                             | `hunk.newRemaining += 1`                   | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:457               | ConditionalExpression | `kind === '-'`                                       | `false`                                    | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:457               | StringLiteral         | `'-'`                                                | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:457               | BlockStatement        | `{ hunk.oldRemaining -= 1; return 'consumed'; }`     | `{}`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:458               | AssignmentOperator    | `hunk.oldRemaining -= 1`                             | `hunk.oldRemaining += 1`                   | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:463               | ConditionalExpression | `kind === ' '`                                       | `true`                                     | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:464               | AssignmentOperator    | `hunk.oldRemaining -= 1`                             | `hunk.oldRemaining += 1`                   | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:465               | AssignmentOperator    | `hunk.newRemaining -= 1`                             | `hunk.newRemaining += 1`                   | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:471 (no coverage) | ConditionalExpression | `kind === '\\'`                                      | `true`                                     | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:471 (no coverage) | ConditionalExpression | `kind === '\\'`                                      | `false`                                    | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:471 (no coverage) | EqualityOperator      | `kind === '\\'`                                      | `kind !== '\\'`                            | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:471 (no coverage) | StringLiteral         | `'\\'`                                               | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:471 (no coverage) | StringLiteral         | `'consumed'`                                         | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:471 (no coverage) | StringLiteral         | `'outside'`                                          | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:483               | LogicalOperator       | `header[1] ?? 1`                                     | `header[1] && 1`                           | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:490               | ConditionalExpression | `line.startsWith(fileHeader)`                        | `true`                                     | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:491               | CallExpression        | `resetHunk(hunk);`                                   | `;`                                        | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:496               | ConditionalExpression | `line.startsWith('diff --git ')`                     | `true`                                     | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:496               | ConditionalExpression | `line.startsWith('diff --git ')`                     | `false`                                    | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:496               | MethodExpression      | `line.startsWith('diff --git ')`                     | `line.endsWith('diff --git ')`             | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:496               | StringLiteral         | `'diff --git '`                                      | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:496               | BlockStatement        | `{ resetHunk(hunk); return { path: undefined }; }`   | `{}`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:497               | CallExpression        | `resetHunk(hunk);`                                   | `;`                                        | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:499               | ObjectLiteral         | `{ path: undefined }`                                | `{}`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:527               | ConditionalExpression | `path !== undefined`                                 | `true`                                     | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:537               | OptionalChaining      | `cuts[index]?.text`                                  | `cuts[index].text`                         | equivalent | `cuts` maps the same items as the loop, so `cuts[index]` always exists.                                  |
| src/reviewCapture/evidenceDecisions.ts:542               | Regex                 | `/^@@ -0,0 \+1(?:,(\d+))? @@/`                       | `/@@ -0,0 \+1(?:,(\d+))? @@/`              | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:542               | Regex                 | `/^@@ -0,0 \+1(?:,(\d+))? @@/`                       | `/^@@ -0,0 \+1(?:,(\d))? @@/`              | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:561               | OptionalChaining      | `wholeFileHunk.exec(lines[start] ?? '')?.[1]`        | `wholeFileHunk.exec(lines[start] ?? '')[1` | equivalent | `findIndex` found a line this regex matches, so the later `exec` never returns null.                     |
| src/reviewCapture/evidenceDecisions.ts:561 (no coverage) | StringLiteral         | `''`                                                 | `"Stryker was here!"`                      | equivalent | `start` is a valid index from `findIndex`, so the fallback is never used.                                |
| src/reviewCapture/evidenceDecisions.ts:563               | MethodExpression      | `lines.slice(start + 1, start + 1 + count)`          | `lines`                                    | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:563               | ArithmeticOperator    | `start + 1`                                          | `start - 1`                                | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:573               | StringLiteral         | `' ${text}'`                                         | `''`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:576               | MethodExpression      | `body.filter((line) => line.startsWith(' '))`        | `body`                                     | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:576               | ArrowFunction         | `(line) => line.startsWith(' ')`                     | `() => undefined`                          | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:576               | MethodExpression      | `line.startsWith(' ')`                               | `line.endsWith(' ')`                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:576               | StringLiteral         | `' '`                                                | `""`                                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:577               | ConditionalExpression | `contextCount === 0`                                 | `true`                                     | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:577               | ConditionalExpression | `contextCount === 0`                                 | `false`                                    | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/evidenceDecisions.ts:577               | EqualityOperator      | `contextCount === 0`                                 | `contextCount !== 0`                       | gap        | No test pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks. |
| src/reviewCapture/gitQuotedName.ts:15                    | Regex                 | `/^[0-7]{3}/`                                        | `/[0-7]{3}/`                               | gap        | No test passes an unterminated quoted name or an escape that is not octal.                               |
| src/reviewCapture/gitQuotedName.ts:23                    | ConditionalExpression | `index < text.length`                                | `true`                                     | gap        | No test passes an unterminated quoted name or an escape that is not octal.                               |
| src/reviewCapture/gitQuotedName.ts:23                    | EqualityOperator      | `index < text.length`                                | `index <= text.length`                     | gap        | No test passes an unterminated quoted name or an escape that is not octal.                               |
| src/reviewCapture/gitQuotedName.ts:26 (no coverage)      | StringLiteral         | `''`                                                 | `"Stryker was here!"`                      | gap        | No test passes an unterminated quoted name or an escape that is not octal.                               |
| src/reviewCapture/reviewCapture.ts:687 (no coverage)     | ObjectLiteral         | `{ ...none, error: '${describeCommand(commandArgume` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:687 (no coverage)     | StringLiteral         | `'${describeCommand(commandArguments)} failed: ${li` | `''`                                       | noise      | Error message text built from the command and the failure detail.                                        |
| src/reviewCapture/reviewCapture.ts:690                   | MethodExpression      | `listed.stdout .toString('utf8') .split('\0') .filt` | `listed.stdout.toString('utf8').split('\0` | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:693                   | ConditionalExpression | `entry !== ''`                                       | `true`                                     | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:693                   | StringLiteral         | `''`                                                 | `"Stryker was here!"`                      | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:722                   | ConditionalExpression | `lineEnd === -1 '' !Number.isInteger(size)`          | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:722                   | LogicalOperator       | `lineEnd === -1 '' !Number.isInteger(size)`          | `lineEnd === -1 && !Number.isInteger(size` | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:722                   | ConditionalExpression | `lineEnd === -1`                                     | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:722                   | UnaryOperator         | `-1`                                                 | `+1`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:722 (no coverage)     | BlockStatement        | `{ return { texts: [], error: '${describeCommand(co` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:723 (no coverage)     | ObjectLiteral         | `{ texts: [], error: '${describeCommand(commandArgu` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:724 (no coverage)     | ArrayDeclaration      | `[]`                                                 | `["Stryker was here"]`                     | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:725 (no coverage)     | StringLiteral         | `'${describeCommand(commandArguments)} printed unex` | `''`                                       | noise      | Error message text built from the command and the failure detail.                                        |
| src/reviewCapture/reviewCapture.ts:729                   | ArithmeticOperator    | `lineEnd + 1`                                        | `lineEnd - 1`                              | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:730                   | ArithmeticOperator    | `lineEnd + size`                                     | `lineEnd - size`                           | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:747                   | ConditionalExpression | `result.exitCode !== 0 '' result.stderr.trim() !== ` | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:747                   | LogicalOperator       | `result.exitCode !== 0 '' result.stderr.trim() !== ` | `result.exitCode !== 0 && result.stderr.t` | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:747                   | ConditionalExpression | `result.exitCode !== 0`                              | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:747                   | ConditionalExpression | `result.stderr.trim() !== ''`                        | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:747                   | MethodExpression      | `result.stderr.trim()`                               | `result.stderr`                            | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:747 (no coverage)     | BlockStatement        | `{ const detail = 'exit ${result.exitCode}: ${resul` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:748 (no coverage)     | StringLiteral         | `'exit ${result.exitCode}: ${result.stderr.trim()}'` | `''`                                       | noise      | Error message text built from the command and the failure detail.                                        |
| src/reviewCapture/reviewCapture.ts:748 (no coverage)     | MethodExpression      | `result.stderr.trim()`                               | `result.stderr`                            | noise      | Whitespace in the detail text of an error message.                                                       |
| src/reviewCapture/reviewCapture.ts:750 (no coverage)     | ObjectLiteral         | `{ texts: [], error: '${describeCommand(commandArgu` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:750 (no coverage)     | ArrayDeclaration      | `[]`                                                 | `["Stryker was here"]`                     | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:750 (no coverage)     | StringLiteral         | `'${describeCommand(commandArguments)} failed: ${de` | `''`                                       | noise      | Error message text built from the command and the failure detail.                                        |
| src/reviewCapture/reviewCapture.ts:754 (no coverage)     | BlockStatement        | `{ return { texts: [], error: '${describeCommand(co` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:755 (no coverage)     | ObjectLiteral         | `{ texts: [], error: '${describeCommand(commandArgu` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:756 (no coverage)     | ArrayDeclaration      | `[]`                                                 | `["Stryker was here"]`                     | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:757 (no coverage)     | StringLiteral         | `'${describeCommand(commandArguments)} failed: ${er` | `''`                                       | noise      | Error message text built from the command and the failure detail.                                        |
| src/reviewCapture/reviewCapture.ts:772                   | LogicalOperator       | `target.kind !== 'files' '' candidates.size === 0`   | `target.kind !== 'files' && candidates.si` | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:772                   | ConditionalExpression | `target.kind !== 'files'`                            | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:772                   | ConditionalExpression | `candidates.size === 0`                              | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:779                   | ConditionalExpression | `listed.stdout === undefined`                        | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:779 (no coverage)     | BlockStatement        | `{ return { texts, error: '${describeCommand(listAr` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:780 (no coverage)     | ObjectLiteral         | `{ texts, error: '${describeCommand(listArguments)}` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:780 (no coverage)     | StringLiteral         | `'${describeCommand(listArguments)} failed: ${liste` | `''`                                       | noise      | Error message text built from the command and the failure detail.                                        |
| src/reviewCapture/reviewCapture.ts:788                   | ConditionalExpression | `meta[1] === 'blob'`                                 | `true`                                     | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:788                   | LogicalOperator       | `meta[1] === 'blob' && candidates.has(path)`         | `meta[1] === 'blob' '' candidates.has(pat` | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:790                   | ConditionalExpression | `entries.length === 0`                               | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:790 (no coverage)     | BlockStatement        | `{ return { texts }; }`                              | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:791 (no coverage)     | ObjectLiteral         | `{ texts }`                                          | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:794 (no coverage)     | StringLiteral         | `''`                                                 | `"Stryker was here!"`                      | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:797                   | ConditionalExpression | `blobs.error !== undefined`                          | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:797 (no coverage)     | BlockStatement        | `{ return { texts, error: blobs.error }; }`          | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:798 (no coverage)     | ObjectLiteral         | `{ texts, error: blobs.error }`                      | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:802 (no coverage)     | StringLiteral         | `''`                                                 | `"Stryker was here!"`                      | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:808                   | ArrowFunction         | `(error: string): WholeFiles => ({ parts: [{ ...emp` | `() => undefined`                          | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:808 (no coverage)     | ObjectLiteral         | `{ parts: [{ ...emptyPart, errors: [error] }], adde` | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:809 (no coverage)     | ArrayDeclaration      | `[{ ...emptyPart, errors: [error] }]`                | `[]`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:809 (no coverage)     | ObjectLiteral         | `{ ...emptyPart, errors: [error] }`                  | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:809 (no coverage)     | ArrayDeclaration      | `[error]`                                            | `[]`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:825                   | ConditionalExpression | `cached.error !== undefined`                         | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:825 (no coverage)     | BlockStatement        | `{ return wholeFileFailure(cached.error); }`         | `{}`                                       | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:829                   | MethodExpression      | `listed.files.filter((file) => !cached.indexed.has(` | `listed.files`                             | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:832                   | ConditionalExpression | `inBase.error !== undefined`                         | `false`                                    | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |
| src/reviewCapture/reviewCapture.ts:907 (no coverage)     | StringLiteral         | `''`                                                 | `"Stryker was here!"`                      | gap        | No test makes this Git read fail or return odd output, such as a bad size or a missing blob.             |

### 23f561ec

| Location                                        | Mutator               | Original                                             | Replacement                                | Kind       | Reason                                                                                               |
| ----------------------------------------------- | --------------------- | ---------------------------------------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------- |
| askUserQuestion/askUserQuestion.ts:139          | StringLiteral         | `'The user typed a free-text answer. If it asks a q` | `""`                                       | noise      | Message or description wording, which the repository rules say not to test.                          |
| askUserQuestion/askUserQuestion.ts:151          | MethodExpression      | `result.answers.some((answer) => answer.typed)`      | `result.answers.every(answer => answer.ty` | gap        | No test mixes typed and selected answers, so some versus every is not pinned.                        |
| askUserQuestion/askUserQuestion.ts:155          | StringLiteral         | `"You can now continue with the user's answers in m` | `""`                                       | noise      | Message or description wording, which the repository rules say not to test.                          |
| askUserQuestion/branchFacts.ts:10               | ConditionalExpression | `details.kind !== 'answered'`                        | `false`                                    | equivalent | A result that is not answered has no answers array, so the next check returns false.                 |
| askUserQuestion/branchFacts.ts:14               | MethodExpression      | `details.answers.some((answer) => isRecord(answer) ` | `details.answers.every(answer => isRecord` | gap        | No test mixes typed and selected answers in one result.                                              |
| askUserQuestion/branchFacts.ts:18               | ConditionalExpression | `!isRecord(block) '' block.type !== 'text'`          | `false`                                    | gap        | No test passes a malformed or non-text content block.                                                |
| askUserQuestion/branchFacts.ts:18               | LogicalOperator       | `!isRecord(block) '' block.type !== 'text'`          | `!isRecord(block) && block.type !== 'text` | gap        | No test passes a malformed or non-text content block.                                                |
| askUserQuestion/branchFacts.ts:18               | ConditionalExpression | `block.type !== 'text'`                              | `false`                                    | gap        | No test passes a malformed or non-text content block.                                                |
| askUserQuestion/branchFacts.ts:18               | BlockStatement        | `{ return false; }`                                  | `{}`                                       | gap        | No test passes a malformed or non-text content block.                                                |
| askUserQuestion/branchFacts.ts:22               | ConditionalExpression | `typeof block.text === 'string'`                     | `true`                                     | gap        | No test passes a text block whose text is not a string.                                              |
| askUserQuestion/branchFacts.ts:29               | ConditionalExpression | `entry.type !== 'message'`                           | `false`                                    | equivalent | An entry that is not a message has no message record, so the next check returns the same empty list. |
| askUserQuestion/branchFacts.ts:29               | BlockStatement        | `{ return []; }`                                     | `{}`                                       | equivalent | An entry that is not a message has no message record, so the next check returns the same empty list. |
| askUserQuestion/branchFacts.ts:35               | ConditionalExpression | `!isRecord(message)`                                 | `false`                                    | gap        | No test passes a message entry that is not a record.                                                 |
| askUserQuestion/branchFacts.ts:35 (no coverage) | BlockStatement        | `{ return []; }`                                     | `{}`                                       | gap        | No test passes a message entry that is not a record.                                                 |
| askUserQuestion/branchFacts.ts:36 (no coverage) | ArrayDeclaration      | `[]`                                                 | `["Stryker was here"]`                     | gap        | No test passes a message entry that is not a record.                                                 |
| askUserQuestion/branchFacts.ts:42               | ConditionalExpression | `message.role === 'toolResult'`                      | `true`                                     | equivalent | Only a tool result carries the ask_user_question tool name, so the role check adds nothing.          |
| askUserQuestion/branchFacts.ts:46               | ConditionalExpression | `message.role === 'assistant'`                       | `true`                                     | gap        | No test puts visible text in a user message after a typed answer.                                    |
| askUserQuestion/branchFacts.ts:47               | ObjectLiteral         | `{ kind: 'visibleText' }`                            | `{}`                                       | equivalent | The guard only tests for the askResult kind, so the visibleText tag is never read.                   |
| askUserQuestion/branchFacts.ts:47               | StringLiteral         | `'visibleText'`                                      | `""`                                       | equivalent | The guard only tests for the askResult kind, so the visibleText tag is never read.                   |

### 290ea97f

| Location                                    | Mutator               | Original                                             | Replacement                                | Kind  | Reason                                                                                       |
| ------------------------------------------- | --------------------- | ---------------------------------------------------- | ------------------------------------------ | ----- | -------------------------------------------------------------------------------------------- |
| draftReview/herdrReview.ts:41               | ConditionalExpression | `pane.pane_id === agentPane`                         | `true`                                     | gap   | No test lays out several panes, so a wrong pane width is not caught.                         |
| draftReview/herdrReview.ts:43               | ConditionalExpression | `found === undefined`                                | `false`                                    | noise | Without the throw, the next line throws a TypeError. Only the error type and wording change. |
| draftReview/herdrReview.ts:43 (no coverage) | BlockStatement        | `{ throw new Error('Missing herdr layout for pane $` | `{}`                                       | noise | Without the throw, the next line throws a TypeError. Only the error type and wording change. |
| draftReview/herdrReview.ts:44 (no coverage) | StringLiteral         | `'Missing herdr layout for pane ${agentPane}.'`      | `''`                                       | noise | Without the throw, the next line throws a TypeError. Only the error type and wording change. |
| draftReview/herdrReview.ts:64               | StringLiteral         | `'--pane'`                                           | `""`                                       | gap   | herdr parses this argument or error code, and no test pins it.                               |
| draftReview/herdrReview.ts:66               | StringLiteral         | `'--direction'`                                      | `""`                                       | gap   | herdr parses this argument or error code, and no test pins it.                               |
| draftReview/herdrReview.ts:67               | StringLiteral         | `'right'`                                            | `""`                                       | gap   | herdr parses this argument or error code, and no test pins it.                               |
| draftReview/herdrReview.ts:70               | StringLiteral         | `'--focus'`                                          | `""`                                       | gap   | herdr parses this argument or error code, and no test pins it.                               |
| draftReview/herdrReview.ts:79               | StringLiteral         | `'pane'`                                             | `""`                                       | gap   | herdr parses this argument or error code, and no test pins it.                               |
| draftReview/herdrReview.ts:91               | StringLiteral         | `'--cwd'`                                            | `""`                                       | gap   | herdr parses this argument or error code, and no test pins it.                               |
| draftReview/herdrReview.ts:93               | StringLiteral         | `'--label'`                                          | `""`                                       | gap   | herdr parses this argument or error code, and no test pins it.                               |
| draftReview/herdrReview.ts:94               | StringLiteral         | `'Draft review'`                                     | `""`                                       | noise | The tab label is display text.                                                               |
| draftReview/herdrReview.ts:106              | StringLiteral         | `'tab_not_found'`                                    | `""`                                       | gap   | herdr parses this argument or error code, and no test pins it.                               |
| src/herdrLayout.ts:15                       | ConditionalExpression | `Number.isSafeInteger(value) && Number(value) > 0`   | `true`                                     | gap   | No test passes a zero, negative, or fractional pane size.                                    |
| src/herdrLayout.ts:15                       | LogicalOperator       | `Number.isSafeInteger(value) && Number(value) > 0`   | `Number.isSafeInteger(value) '' Number(va` | gap   | No test passes a zero, negative, or fractional pane size.                                    |
| src/herdrLayout.ts:15                       | EqualityOperator      | `Number(value) > 0`                                  | `Number(value) >= 0`                       | gap   | No test passes a zero, negative, or fractional pane size.                                    |
| src/herdrLayout.ts:15                       | ConditionalExpression | `Number(value) > 0`                                  | `true`                                     | gap   | No test passes a zero, negative, or fractional pane size.                                    |
| src/herdrLayout.ts:20                       | ConditionalExpression | `!isPositiveInteger(bounds.width) '' !isPositiveInt` | `false`                                    | gap   | No test passes invalid pane dimensions.                                                      |
| src/herdrLayout.ts:20                       | LogicalOperator       | `!isPositiveInteger(bounds.width) '' !isPositiveInt` | `!isPositiveInteger(bounds.width) && !isP` | gap   | No test passes invalid pane dimensions.                                                      |
| src/herdrLayout.ts:20 (no coverage)         | BlockStatement        | `{ throw new Error('Invalid herdr pane dimensions.'` | `{}`                                       | gap   | No test passes invalid pane dimensions.                                                      |
| src/herdrLayout.ts:21 (no coverage)         | StringLiteral         | `'Invalid herdr pane dimensions.'`                   | `""`                                       | noise | Message or description wording, which the repository rules say not to test.                  |
| src/herdrLayout.ts:30                       | ConditionalExpression | `typeof layout.zoomed !== 'boolean'`                 | `false`                                    | gap   | No test passes a layout without a zoom state.                                                |
| src/herdrLayout.ts:30 (no coverage)         | BlockStatement        | `{ throw new TypeError('Missing herdr zoom state.')` | `{}`                                       | gap   | No test passes a layout without a zoom state.                                                |
| src/herdrLayout.ts:31 (no coverage)         | StringLiteral         | `'Missing herdr zoom state.'`                        | `""`                                       | noise | Message or description wording, which the repository rules say not to test.                  |

### a242c016

| Location                           | Mutator               | Original                                             | Replacement                                | Kind       | Reason                                                                                                                 |
| ---------------------------------- | --------------------- | ---------------------------------------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| fullCheck/run.ts:168               | ConditionalExpression | `stopped`                                            | `false`                                    | gap        | No test calls stop twice, so a second kill is not pinned.                                                              |
| fullCheck/run.ts:168 (no coverage) | BlockStatement        | `{ return; }`                                        | `{}`                                       | gap        | No test calls stop twice, so a second kill is not pinned.                                                              |
| fullCheck/run.ts:172               | BooleanLiteral        | `true`                                               | `false`                                    | gap        | Same gap: the stopped flag is not pinned. An earlier run killed this mutant, so the result varies.                     |
| fullCheck/run.ts:192               | ConditionalExpression | `commandIsIdle({ now, lastOutputAt, idleLimitMillis` | `true`                                     | gap        | Idle detection when output is still changing is pinned only by timing. An earlier run killed it, so the result varies. |
| fullCheck/run.ts:193               | CallExpression        | `clearInterval(idleMonitor);`                        | `;`                                        | equivalent | Other code also clears the interval: the close handler and the finally block each clear it.                            |
| fullCheck/run.ts:198               | MethodExpression      | `Math.min(idlePollCeilingMilliseconds, idleLimitMil` | `Math.max(idlePollCeilingMilliseconds, id` | gap        | No test pins the idle poll interval, so a slower poll delays hang detection unseen.                                    |
| fullCheck/run.ts:198               | ArithmeticOperator    | `idleLimitMilliseconds / idlePollsPerLimit`          | `idleLimitMilliseconds * idlePollsPerLimi` | gap        | No test pins the idle poll interval, so a slower poll delays hang detection unseen.                                    |
| fullCheck/run.ts:202               | CallExpression        | `clearTimeout(killTimer);`                           | `;`                                        | equivalent | The kill timer is set only after stop runs. A spawn error comes before, so the timer is undefined.                     |
| fullCheck/run.ts:207               | CallExpression        | `clearInterval(idleMonitor);`                        | `;`                                        | equivalent | Other code also clears the interval: the close handler and the finally block each clear it.                            |
| fullCheck/run.ts:280               | CallExpression        | `clearInterval(idleMonitor);`                        | `;`                                        | equivalent | Other code also clears the interval: the close handler and the finally block each clear it.                            |
| fullCheck/tool.ts:60               | StringLiteral         | `''`                                                 | `"Stryker was here!"`                      | noise      | Message or description wording, which the repository rules say not to test.                                            |
| fullCheck/tool.ts:62               | StringLiteral         | `'passed'`                                           | `""`                                       | noise      | Message or description wording, which the repository rules say not to test.                                            |
| fullCheck/tool.ts:62               | StringLiteral         | `'failed'`                                           | `""`                                       | noise      | Message or description wording, which the repository rules say not to test.                                            |
| fullCheck/tool.ts:91               | BooleanLiteral        | `false`                                              | `true`                                     | gap        | A reused result with idle true would print the hung-command text. No test reads that field.                            |

### cdb006a5

| Location                           | Mutator               | Original                                             | Replacement | Kind | Reason                                                                                 |
| ---------------------------------- | --------------------- | ---------------------------------------------------- | ----------- | ---- | -------------------------------------------------------------------------------------- |
| tracker/linear.ts:49               | ObjectLiteral         | `{ team: Type.Union([Type.Object({ id: Type.String(` | `{}`        | gap  | An empty schema accepts any team response. No test sends a malformed team response.    |
| tracker/linear.ts:50               | ObjectLiteral         | `{ id: Type.String() }`                              | `{}`        | gap  | An empty schema accepts any team response. No test sends a malformed team response.    |
| tracker/linear.ts:96               | ConditionalExpression | `!Value.Check(teamSchema, response.data)`            | `false`     | gap  | No test sends a malformed team response, so the unexpected-output error is not pinned. |
| tracker/linear.ts:96 (no coverage) | BlockStatement        | `{ throw unexpectedOutput(response); }`              | `{}`        | gap  | No test sends a malformed team response, so the unexpected-output error is not pinned. |

### fd5d2213

| Location               | Mutator               | Original                                             | Replacement                | Kind       | Reason                                                                                            |
| ---------------------- | --------------------- | ---------------------------------------------------- | -------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| fullCheck/queue.ts:297 | MethodExpression      | `repository.toLowerCase()`                           | `repository.toUpperCase()` | equivalent | Upper case also ignores case, so two spellings of one name still share one lock file.             |
| fullCheck/tool.ts:157  | ConditionalExpression | `repository === undefined`                           | `false`                    | equivalent | With no repository, readFullCheckArgv returns undefined, so the next check throws the same error. |
| fullCheck/tool.ts:216  | StringLiteral         | `'Run the repository full check, queued per reposit` | `""`                       | noise      | Message or description wording, which the repository rules say not to test.                       |

## Settings

The final `stryker.config.json` differs from the starting config in four places: `vitest.related`,
`dryRunTimeoutMinutes`, `fileLogLevel`, and `tempDirName`.

Changed settings:

- `vitest.related`: `true` (was `false`). With `false`, the first try on `fd5d2213` ran every test
  of `src/` in the dry run. It hit Stryker's 5 minute dry-run limit at load average 134 and failed
  with no result. With `true`, Vitest runs only the tests related to the mutated files, and the same
  commit finished in 134 seconds. Cost: a test that related mode does not pick can leave a mutant as
  a survivor. On the six commits, related mode killed 570 of 768 mutants and left 54 with no
  coverage.
- `dryRunTimeoutMinutes`: `20` (new). The related set of `e9696243` is large, and a 5 minute dry run
  failed at load average 85. Twenty minutes gave the dry run room under load. The five smaller
  commits finished the dry run well inside the default.
- `fileLogLevel`: `off` (was `info`). A `stryker.log` file in the repository root makes `pnpm check`
  rerun the test projects that list the root.
- `tempDirName`: `.tau/stryker-tmp` (was `.stryker-tmp`). A folder in the repository root has the
  same effect. Git ignores `.tau/`.

Settings kept as they are:

- `mutator.excludedMutations`: not set, so no mutator is excluded. The data suggested excluding
  `StringLiteral`, but the exclusion would hide real gaps. Of the 44 `StringLiteral` survivors in
  the six final reports, 16 are noise (message and label wording), 1 is equivalent, and 27 are real
  gaps. Wording noise stays visible until a later slice adds a shared ignorer for error wording. The
  exclusion would hide these 8 real gaps in `src/extensions/draftReview/herdrReview.ts` of
  `290ea97f`, where herdr parses the value: line 64 `'--pane'`, line 66 `'--direction'`, line 67
  `'right'`, line 70 `'--focus'`, line 79 `'pane'`, line 91 `'--cwd'`, line 93 `'--label'`, and line
  106 `'tab_not_found'`.

Settings kept as they are:

- `testRunner`: `vitest`. The repository uses Vitest, and every run worked.
- `vitest.configFile`: `stryker.vitest.config.ts`. It removes the Vite+ projects and the integration
  tests, and every run used it.
- `testFiles`: not set. `related: true` already limits the tests to the mutated files. A fixed list
  cannot follow a different commit each time.
- `coverageAnalysis`: `perTest`. Stryker ran only the tests that cover a mutant. No data argues for
  a change.
- `mutate`: the production globs. Every mutated file in the runs was under `src/`.
- `tsconfigFile`: `stryker-no-tsconfig.json`. The file does not exist, so Stryker does not rewrite
  any tsconfig. No run failed on it.
- `checkers`: empty. A checker would slow the runs. The runs showed one invalid mutant in 768
  (`e9696243`), so none is needed.
- `concurrency`: `6`. This is the worker limit that `vite.config.ts` uses for a full run. Five runs
  with six workers each ran at once on a loaded machine without a mutant timeout, so the data gives
  no reason to change it.
- `timeoutMS`: `20000`. Five of the six commits had 0 timed-out mutants in every run. `e9696243` had
  8 timed-out mutants in each of the runs that reached the mutation phase, at load averages from 10
  to 64. The count is the same at different loads, so the mutants cause the timeouts, probably
  loops, and the load does not. Stryker counts a timeout as detected, so the value stays.
- `ignorePatterns`: `.tau`, `docs`, `CHANGELOG.md`. They keep Stryker from copying files that the
  tests do not need into the sandbox.
- `cleanTempDir`: `true`. The sandbox is removed after a run.

## Rerun with the final config

All six commits ran with the final config, which excludes no mutator. Every survivor in every report
is listed above, so no survivor of an excluded mutator exists. The survivors remain for the reasons
in the table. A real gap remains because no test pins the behavior, and the repository rules forbid
closing it in this work. An equivalent remains because the code gives no observable difference. A
noise survivor remains because the repository rules say not to test wording.

| Commit   | Survivors | Real gap | Equivalent | Noise | Why they remain                                                                                        |
| -------- | --------- | -------- | ---------- | ----- | ------------------------------------------------------------------------------------------------------ |
| e9696243 | 125       | 112      | 6          | 7     | Diff parser, quoted names, and Git read paths that no test makes fail or return odd output.            |
| 23f561ec | 19        | 11       | 6          | 2     | Malformed session entries and mixed typed answers that no test sends.                                  |
| 290ea97f | 24        | 18       | 0          | 6     | herdr arguments and pane size checks that no test pins.                                                |
| a242c016 | 14        | 7        | 4          | 3     | Idle polling and a second stop that no test pins. Some are timing based. Others are equivalent clears. |
| cdb006a5 | 4         | 4        | 0          | 0     | A malformed team response that no test sends.                                                          |
| fd5d2213 | 3         | 0        | 2          | 1     | Both non-noise mutants change nothing a caller can observe.                                            |

## Real gaps

These are for a follow-up ticket. This work changed no production code or test.

- e9696243, pr/evidence.ts lines 112, 113, 115, 116, 279: No test reads scan gaps or a failed marker
  read into the publication evidence.
- e9696243, src/git.ts lines 100: No test runs a command without input that reads stdin, so closing
  it early is not pinned.
- e9696243, src/reviewCapture/evidenceDecisions.ts lines 412, 414, 422, 426, 431, 442, 444, 451,
  457, 458, 463, 464, 465, 471, 483, 490, 491, 496, 497, 499, 527, 542, 563, 573, 576, 577: No test
  pins this step of the diff parser, such as multi-digit counts, quoted names, or truncated hunks.
- e9696243, src/reviewCapture/gitQuotedName.ts lines 15, 23, 26: No test passes an unterminated
  quoted name or an escape that is not octal.
- e9696243, src/reviewCapture/reviewCapture.ts lines 687, 690, 693, 722, 723, 724, 729, 730, 747,
  750, 754, 755, 756, 772, 779, 780, 788, 790, 791, 794, 797, 798, 802, 808, 809, 825, 829, 832,
  907: No test makes this Git read fail or return odd output, such as a bad size or a missing blob.
- 23f561ec, askUserQuestion/askUserQuestion.ts lines 151: No test mixes typed and selected answers,
  so some versus every is not pinned.
- 23f561ec, askUserQuestion/branchFacts.ts lines 14: No test mixes typed and selected answers in one
  result.
- 23f561ec, askUserQuestion/branchFacts.ts lines 18: No test passes a malformed or non-text content
  block.
- 23f561ec, askUserQuestion/branchFacts.ts lines 22: No test passes a text block whose text is not a
  string.
- 23f561ec, askUserQuestion/branchFacts.ts lines 35, 36: No test passes a message entry that is not
  a record.
- 23f561ec, askUserQuestion/branchFacts.ts lines 46: No test puts visible text in a user message
  after a typed answer.
- 290ea97f, draftReview/herdrReview.ts lines 41: No test lays out several panes, so a wrong pane
  width is not caught.
- 290ea97f, draftReview/herdrReview.ts lines 64, 66, 67, 70, 79, 91, 93, 106: herdr parses this
  argument or error code, and no test pins it.
- 290ea97f, src/herdrLayout.ts lines 15: No test passes a zero, negative, or fractional pane size.
- 290ea97f, src/herdrLayout.ts lines 20: No test passes invalid pane dimensions.
- 290ea97f, src/herdrLayout.ts lines 30: No test passes a layout without a zoom state.
- a242c016, fullCheck/run.ts lines 168: No test calls stop twice, so a second kill is not pinned.
- a242c016, fullCheck/run.ts lines 172: Same gap: the stopped flag is not pinned. An earlier run
  killed this mutant, so the result varies.
- a242c016, fullCheck/run.ts lines 192: Idle detection when output is still changing is pinned only
  by timing. An earlier run killed it, so the result varies.
- a242c016, fullCheck/run.ts lines 198: No test pins the idle poll interval, so a slower poll delays
  hang detection unseen.
- a242c016, fullCheck/tool.ts lines 91: A reused result with idle true would print the hung-command
  text. No test reads that field.
- cdb006a5, tracker/linear.ts lines 49, 50: An empty schema accepts any team response. No test sends
  a malformed team response.
- cdb006a5, tracker/linear.ts lines 96: No test sends a malformed team response, so the
  unexpected-output error is not pinned.
- The 8 herdr argument gaps of `290ea97f` are listed in the `mutator.excludedMutations` setting
  above. They stay visible because the config excludes no mutator.
- Two earlier `e9696243` runs ended with SIGTERM for an unknown reason. Run it alone on a quiet
  machine to find the cause.
- The `a242c016` survivors at `run.ts` lines 168, 172, and 192 vary between runs. An earlier run
  killed them. Their tests depend on timing.
