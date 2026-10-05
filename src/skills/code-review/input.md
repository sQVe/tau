# Review input

Use this shape for `$dir/input.md`. Fill in each section before the `capture` call. Mark context you
do not have as unavailable. Do not invent requirements or copy the whole conversation. Keep
`## Capture` as the last heading: the `code_review` tool appends the capture and a `## Gaps` section
after it.

```markdown
# Review input

## Target

The target, the mode, the base and HEAD SHAs, and the exclusions the user declared.

## Rules

The rule files that apply, such as `AGENTS.md` and the decision records it links.

## Checks

Any existing check result with its saved output path, or "none".

## Intent

The known task intent, acceptance criteria, and intentional behavior changes.

## Capture
```
