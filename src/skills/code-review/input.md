# Review input

Use this shape for `$dir/input.md`, filled in before the `capture` call. Mark missing context as
unavailable. Do not invent requirements or copy the conversation. Keep `## Capture` last and empty:
the tool appends the capture and `## Gaps` after it, and nothing edits them.

```markdown
# Review input

## Target

The target, mode, and declared exclusions. The base SHA, or none for a root commit. The repository
HEAD from `git rev-parse HEAD`, even when a range ends at another commit.

## Rules

The rule files that apply, such as `AGENTS.md` and the decision records it links.

## Checks

Any existing check result with its saved output path, or "none".

## Intent

The task intent and intentional behavior changes. The acceptance criteria, one per line, word for
word, or "none". For a fix review, the findings the fix closes, each with its file and line.

## Capture
```
