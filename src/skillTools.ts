import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const skillTools: Readonly<Record<string, readonly string[]>> = {
  'code-review': ['code_review', 'tracker_draft'],
  brainstorm: ['slice', 'draft_review'],
  slice: ['slice', 'draft_review'],
  'finish-slice': ['slice', 'start_slice'],
  'start-slice': ['slice', 'start_slice', 'stack'],
  handover: ['handover'],
  stack: ['stack'],
  'update-branch': ['stack'],
  pr: ['pr', 'full_check', 'mutation_check', 'stack', 'draft_review'],
  tdd: ['full_check', 'mutation_check'],
  'fix-bug': ['full_check'],
  'pr-feedback': ['pr_feedback'],
  tracker: ['tracker_evidence', 'tracker_draft', 'draft_review'],
};

const skillToolsPath = fileURLToPath(import.meta.url);
const loadedSource = readFileSync(skillToolsPath, 'utf8');

// A worker loads this file again from disk and checks that Pi registered every tool it lists. Pi
// registers only the tools the parent passed, so a parent with an older copy starts workers that fail.
export const skillToolsChangedOnDisk = (): boolean =>
  readFileSync(skillToolsPath, 'utf8') !== loadedSource;
