import { expect, it } from 'vitest';

import { workerTools } from './workerTools.js';

it.each([
  { skills: [], expected: [] },
  { skills: ['/skills/tracker/SKILL.md'], expected: ['tracker_evidence'] },
  { skills: ['/skills/tdd/SKILL.md'], expected: [] },
  {
    skills: ['/skills/tracker/SKILL.md', '/skills/review/SKILL.md'],
    expected: ['tracker_evidence', 'review_evidence'],
  },
  {
    skills: ['/skills//tracker/SKILL.md', '/other/tracker/SKILL.md'],
    expected: ['tracker_evidence'],
  },
])('adds only the tools for loaded skills: $skills', ({ skills, expected }) => {
  const loadout = { tools: ['read', 'read', 'subagent_report'], skills };

  const skillTools = {
    tracker: ['tracker_evidence', 'read'],
    review: ['review_evidence', 'tracker_evidence'],
  };

  expect(workerTools(loadout, skillTools)).toEqual([
    'read',
    'subagent_report',
    'subagent_progress',
    'subagent_question',
    ...expected,
  ]);
});
