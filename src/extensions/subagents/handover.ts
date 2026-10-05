export const assignmentContract = [
  'Own the assigned outcome through to completion: acceptance criteria, exploration, design, implementation, tests, and debugging.',
  'Tests, docs, and checks the assignment names are part of the work, not follow-ups.',
  'The parent assigns one editor per worktree, and you are it for this assignment.',
  'Report changes you did not make instead of claiming them.',
  'A failed approach or a blocked tool call is not a handover: correct it within the safety rules and continue.',
  'Ask the parent only about ambiguous requirements, changed scope or authority, external blockers, or exhausted limits, not ordinary implementation decisions.',
].join(' ');

// Investigators keep their profile's read-only boundary; only editors own implementation work.
export const assignmentContractFor = (role: 'editing' | 'investigation'): string =>
  role === 'editing' ? `${assignmentContract}\n\n` : '';

export const handoverContract = [
  [
    'Report when the assignment is done or a blocker stops you.',
    'success means every acceptance criterion is met and checked; failure means it cannot be met;',
    'incomplete means a named blocker stops you. Remaining steps are not a blocker.',
    'Write each section as a heading with compact bullets, None when empty, and name saved files instead of pasting logs, diffs, or long output.',
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
  '- Decisions: consequential choices with their reasons.',
  '- Concerns: unresolved risks and decisions the parent must make.',
].join('\n');
