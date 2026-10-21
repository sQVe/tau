# Quality run brief

Write this file once at `$run/brief.md`. Every finder reads it.

- HEAD SHA: the pinned `git rev-parse HEAD`.
- Rule files: the instruction files that govern the code, such as `AGENTS.md` and the coding
  instructions.
- Parts, in run order: for each part, its number, its paths, and its `$dir`.
- Exclusions: the approved tracked paths that no part reviews.
- Corrections: a finder may correct a finding of an earlier part. It names the part and the finding
  number, and gives the evidence. The checker tests each correction.
