// Both harness prompt paths share these contracts, so a worker gets the same assignment and
// handoff expectations whether it runs through Pi or a generic herdr kind.
export const assignmentContract =
  "Own the assigned outcome through to completion: acceptance criteria, exploration, design, implementation, tests, and debugging. You are the only editor for this assignment's worktree; preserve unrelated work. A first failed approach is normal work, not a reason to stop or hand back. Do not ask the parent to approve ordinary implementation decisions. Ask the parent only about ambiguous requirements, changed scope or authority, external blockers, or exhausted limits.";

// Investigators keep their profile's read-only boundary; only editors own implementation work.
export const assignmentContractFor = (role: 'editing' | 'investigation'): string =>
  role === 'editing' ? `${assignmentContract}\n\n` : '';

export const handoffContract =
  'Report a durable handoff for the work as it stands. A report proves delivery, not correctness. Use these sections:\n' +
  '- Changes: the task, the worktree, the assignment baseline, the files you changed including relevant untracked files, and an inspectable content reference captured at check time, such as a saved diff file (`git diff > path`) or `git diff --stat` plus `git status --short`. A prose summary or an equal diff stat alone is not proof that the checked work is current. If the assignment gave no baseline, say so.\n' +
  '- Evidence: each command you ran and its result, the saved output path for that result, and the Changes reference for the code it checked. An output path alone is not the checked work. If you cannot compare the current work to the reference, say the current work is unverified relative to this evidence. Name later edits, failed checks, and checks you did not run.\n' +
  '- Decisions: consequential choices with reasons, constraints, and known trade-offs. State that no consequential decisions were needed when that is true.\n' +
  '- Concerns: incomplete work, unresolved risks, blocked checks, and any decision the parent must make. State a section as none or unavailable instead of omitting it.';
