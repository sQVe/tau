# Review input

Use this shape for `$dir/input.md`. Fill in each section before the `capture` call. Mark context you
do not have as unavailable. Do not invent requirements or copy the whole conversation. Keep
`## Capture` as the last heading: the `code_review` tool appends the capture and a `## Gaps` section
after it.

```markdown
# Review input

## Target

The target, the mode, and the exclusions the user declared. The base SHA, which is the start of a
range, or none for a root commit. The repository HEAD from `git rev-parse HEAD`, even when a range
ends at another commit.

## Rules

The rule files that apply, such as `AGENTS.md` and the decision records it links.

## Checks

Any existing check result with its saved output path, or "none".

## Intent

The known task intent, acceptance criteria, and intentional behavior changes.

## Capture
```
