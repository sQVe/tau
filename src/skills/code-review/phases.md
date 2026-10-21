# Shared review phases

The [code-review](SKILL.md) and [code-quality](../code-quality/SKILL.md) skills both follow these
phases. Each skill owns its mode, fix target, ticket, and repo-run decisions.

## Resolve the target

Resolve the target once as a `code_review` target, with every revision pinned by `git rev-parse`.

- No target: on the default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`), a
  `workingTree` from `HEAD`. On another branch, a `workingTree` from
  `git merge-base <default> HEAD`.
- A commit: a `range` from its parent, or a `rootCommit` when it has none. `A..B`: a `range`. Named
  files: a `files` target, which reviews them even without changes.
- Pass declared exclusions as `exclude`. Ask when the target, base, or ownership is unclear.

## Handle the capture result

Call `code_review` `prepare`, and use the returned directory as `$dir`. Write `$dir/input.md` from
the [input template](input.md). Then call `capture` with `$dir` and the target. If either call
fails, stop and report the error.

- Ask the user about each `unmatched` gap first. On a corrected path, resolve the target again and
  repeat this phase with a fresh `prepare`, because a directory holds only one capture.
- Before the `empty` check, apply any rule of the calling skill that widens the capture.
- `empty` with no gaps: say there is nothing to review and stop. `empty` with gaps: report them and
  stop.
- When `head` or `base` differs from `input.md`, the target moved: resolve the target again and
  repeat this phase with a fresh `prepare`.

## Gather evidence

Use one read-only `codemode` script. It returns the full `code_review` `evidence` result for `$dir`,
and line-numbered excerpts of the rule files that bear on the changed paths, read with
`git show <sha>:<path>` for a pinned commit. Save the result as `$dir/evidence.md`. If the script
fails, record a gap and continue with `input.md` alone.

## Run the workers

- On the user's own work, add "Also list worthwhile pre-existing issues in touched code."
- Before each launch, check the elapsed time. Past the aim, show the findings so far and ask whether
  to continue.
- Do not relaunch a worker that fails or stops without a report, beyond the one retry. Show its
  notes as unverified leads and mark the review incomplete.
- Always report finished results, even after the aim has passed.
