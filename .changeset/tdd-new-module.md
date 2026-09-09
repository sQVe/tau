---
'tau': minor
---

Make the TDD gate workable without git ceremony. One behavior may name several tests in
`testFullName`; all of them must fail in RED and pass in GREEN. A test edited after RED is accepted
by the next focused pass, and the full run reports it as edited after RED next to the tests in the
required files that never failed and were not already committed. Protected input changes preserve
RED but invalidate full verification. Returning to an earlier behavior keeps its proven RED, also
after a verified full run, tests proven RED stay known across verified task boundaries, and the
`behavior` label no longer forms part of a behavior's identity. Files outside the worktree are not
gated, and a symlinked spelling of the worktree cannot slip a production file past the globs. The
runner spawns vitest with node even when Pi runs as a compiled executable. The `tdd` skill describes
the new-module sequence through an empty file created with `write`, and puts the focused run before
the implementation, with the repository's format, typecheck, and lint checks after it.
