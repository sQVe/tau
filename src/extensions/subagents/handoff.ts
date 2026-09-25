// Both harness prompt paths share these contracts, so a worker gets the same assignment and
// handoff expectations whether it runs through Pi or a generic herdr kind.
export const assignmentContract = [
  'Own the assigned outcome through to completion: acceptance criteria, exploration, design, implementation, tests, and debugging.',
  'Tests, docs, and checks the assignment names are part of the work, not follow-ups.',
  'The parent assigns one editor per worktree, and you are it for this assignment.',
  'Preserve changes you did not make and report them instead of claiming them.',
  'A first failed approach is normal work, not a reason to stop or hand back.',
  'A blocked or failed tool call alone is not a handoff: correct the call within the safety rules and continue.',
  'Do not ask the parent to approve ordinary implementation decisions.',
  'Ask the parent only about ambiguous requirements, changed scope or authority, external blockers, or exhausted limits.',
].join(' ');

// Investigators keep their profile's read-only boundary; only editors own implementation work.
export const assignmentContractFor = (role: 'editing' | 'investigation'): string =>
  role === 'editing' ? `${assignmentContract}\n\n` : '';

export const handoffContract = [
  [
    'Report when the assignment is done or a blocker stops you.',
    'success means every acceptance criterion is met and checked; failure means it cannot be met;',
    'incomplete means a named blocker stops you: an external dependency, an exhausted limit, or a parent decision.',
    'Remaining steps are not a blocker. A report proves delivery, not correctness.',
    'Write each section below as a heading followed by compact bullets and references, and write None under a section that is empty.',
    'Leave logs, diffs, and long output in saved files and the evidence list; name their paths instead of pasting them.',
  ].join(' '),
  [
    '- Changes: the worktree, the assignment baseline or that none was given, the changed files including relevant untracked ones,',
    'and a content reference captured at check time: a saved full diff (`git diff > path`) plus `git hash-object` hashes of relevant untracked files.',
    'A diff stat or status listing does not prove the checked work is current.',
  ].join(' '),
  [
    '- Evidence: each command, its result, and its saved output path, checked against the Changes reference.',
    'Name later edits, failed checks, and checks you did not run; if you cannot compare the current work to the reference, say it is unverified.',
  ].join(' '),
  '- Decisions: consequential choices, each with its reason and trade-off.',
  '- Concerns: for an incomplete outcome, the blocker first; then unresolved risks, blocked checks, and decisions the parent must make.',
].join('\n');
