import { expect, it } from 'vitest';

import { skillTools as bundledSkillTools } from '../../skillTools.js';
import { workerTools } from './workerTools.js';

it.each([
  { skills: [], expected: [] },
  { skills: ['/skills/tracker/SKILL.md'], expected: ['tracker_evidence'] },
  { skills: ['/skills/tdd/SKILL.md'], expected: [] },
  { skills: ['/skills/constructor/SKILL.md'], expected: [] },
  {
    skills: ['/skills/tracker/SKILL.md', '/skills/review/SKILL.md'],
    expected: ['tracker_evidence', 'review_evidence'],
  },
  {
    skills: ['/skills//tracker/SKILL.md', '/other/tracker/SKILL.md'],
    expected: ['tracker_evidence'],
  },
])('adds only the tools for loaded skills: $skills', ({ skills, expected }) => {
  const loadout = {
    tools: ['read', 'read', 'subagent_report'],
    skills,
    role: 'investigation' as const,
  };

  const skillTools = {
    tracker: ['tracker_evidence', 'read'],
    review: ['review_evidence', 'tracker_evidence'],
  };

  expect(workerTools(loadout, skillTools)).toEqual([
    'read',
    'subagent_report',
    'subagent_question',
    ...expected,
  ]);
});

it('an editing worker keeps full_check and an investigator does not', () => {
  const loadout = { tools: ['read', 'full_check'], skills: [] };

  expect(workerTools({ ...loadout, role: 'editing' }, bundledSkillTools)).toContain('full_check');

  expect(workerTools({ ...loadout, role: 'investigation' }, bundledSkillTools)).not.toContain(
    'full_check',
  );
});

it('gives a worker that loads the tdd skill the mutation_check tool', () => {
  const loadout = { tools: ['read'], skills: ['/skills/tdd/SKILL.md'], role: 'editing' as const };

  expect(workerTools(loadout, bundledSkillTools)).toContain('mutation_check');
});

it('finds the skill by the directory above SKILL.md at any depth', () => {
  const skills = ['/home/user/.pi/agent/skills/tracker/SKILL.md'];

  expect(
    workerTools({ tools: [], skills, role: 'investigation' }, { tracker: ['tracker_evidence'] }),
  ).toContain('tracker_evidence');
});

it('finds the skill when the path holds a doubled slash', () => {
  const skills = ['/home/user/skills/tracker//SKILL.md'];

  expect(
    workerTools({ tools: [], skills, role: 'investigation' }, { tracker: ['tracker_evidence'] }),
  ).toContain('tracker_evidence');
});

it('adds no skill tool for a skill that has none', () => {
  const skills = ['/home/user/skills/other/SKILL.md'];

  expect(
    workerTools(
      { tools: ['read'], skills, role: 'investigation' },
      { tracker: ['tracker_evidence'] },
    ),
  ).toEqual(['read', 'subagent_report', 'subagent_question']);
});
