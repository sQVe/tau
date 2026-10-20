import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const skillTools: Readonly<Record<string, readonly string[]>> = {
  'code-review': ['code_review', 'tracker_draft'],
  'code-quality': ['code_review'],
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

export const skillToolsPath = fileURLToPath(import.meta.url);
export const loadedSkillToolsSource = readFileSync(skillToolsPath, 'utf8');
