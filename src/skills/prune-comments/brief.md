# Prune brief

Give this brief to the worker, with `$dir` replaced by the capture directory.

```markdown
Judge the comments in the target and decide which to keep. Change nothing.

- Read `$dir/input.md` in full, continuing with offsets, and `$dir/evidence.md` when it exists. Read
  pinned commits with `git show <sha>:<path>`, not from the working tree.
- Find comments by each language's syntax. This includes doc comments, such as JSDoc, docstrings,
  and rustdoc.
- For a diff target, judge only comments that the diff adds or changes. For a `files` target, judge
  every comment in the named files.
- Keep test: keep a comment only when you can name the concrete wrong change a reader would make
  without it, and the names, types, and tests do not already prevent that change. Delete every other
  comment, doc comments included.
- Never judge these three classes. Leave them out of the rows:
  - tool directives, such as lint, type-check, and formatter markers
  - license headers
  - generated files
- Output one row per judged comment, in file and line order:
  - `file:line`, where the comment starts
  - the exact comment text
  - `keep` with the named wrong change, or `delete`
- Do not reword a comment, suggest new text, or add a comment.
- Name the files you could not read, and list any comment you could not judge.
```
