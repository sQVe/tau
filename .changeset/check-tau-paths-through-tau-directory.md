---
'tau': patch
---

Every check that a directory sits in `.tau/`, and every refusal of a linked file there, now uses one
rule. These behaviors changed:

- `pr_feedback` and `slice` accept a directory whose name starts with `..`, such as `..x`. Only a
  whole `..` segment leaves `.tau/`.
- Review capture treats a path that climbs out through a backslash, such as `..\x`, as outside the
  repository on every platform.
- A directory outside its place now reads `<label> must be in .tau/<parent>, not <directory>.`,
  `<label> must sit directly in .tau/<parent>, not <directory>.`,
  `<label> must name a directory in .tau/<parent>, not <directory>.`, or
  `<label> must be named <prefix>* by prepare, not <directory>.` The label is
  `The feedback directory` (`pr_feedback`), `The draft directory` (`slice`, `start_slice`),
  `The body directory` (`pr`), `The review directory` (`code_review`, `pr`), or
  `The draft_review directory` (`draft_review`).
- A linked file reads `Refusing to read through a symlink: <path>`,
  `Refusing to write through a symlink: <path>`, or the same with `a file with another hard link` in
  place of `a symlink`. This covers the review directory files, the `pr` body, and slice draft
  files.
- The review directory files, the `pr` body, and slice draft files are refused when they are not a
  regular file, such as a FIFO, with
  `Refusing to <verb> through a file that is not a regular file: <path>`. Before, `code_review` and
  `pr` verify could wait forever to read a FIFO.
