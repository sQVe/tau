export const skillTools: Readonly<Record<string, readonly string[]>> = {
  'code-review': ['code_review', 'tracker_draft'],
  brainstorm: ['slice'],
  slice: ['slice'],
  'finish-slice': ['slice'],
  'start-slice': ['slice'],
  handover: ['handover'],
  pr: ['pr', 'full_check'],
  tdd: ['full_check'],
  'fix-bug': ['full_check'],
  'pr-feedback': ['pr_feedback'],
  tracker: ['tracker_evidence', 'tracker_draft'],
};
