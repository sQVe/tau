import { expect, it } from 'vitest';

import { skillToolsRefusal } from './skillToolsRefusal.js';

it.each([
  {
    case: 'every listed tool is registered',
    current: { tdd: ['full_check'] },
    registered: ['full_check'],
  },
  {
    case: 'one tool is listed under two skills and registered',
    current: { tdd: ['slice'], pr: ['slice'] },
    registered: ['slice'],
  },
  {
    case: 'a registered tool is not listed',
    current: { tdd: ['full_check'] },
    registered: ['full_check', 'read'],
  },
])('allows a launch when $case', ({ current, registered }) => {
  expect(skillToolsRefusal(current, new Set(registered))).toBeUndefined();
});

it.each([
  {
    case: 'one listed tool is not registered',
    current: { tdd: ['full_check', 'mutation_check'] },
    registered: ['full_check'],
    missing: ['mutation_check'],
  },
  {
    case: 'two listed tools are not registered',
    current: { tdd: ['mutation_check'], 'pr-feedback': ['pr_feedback'] },
    registered: [],
    missing: ['mutation_check', 'pr_feedback'],
  },
  {
    case: 'a tool is missing under two skills',
    current: { tdd: ['mutation_check'], pr: ['mutation_check'] },
    registered: [],
    missing: ['mutation_check'],
  },
])('refuses a launch and names the tools when $case', ({ current, registered, missing }) => {
  const refusal = skillToolsRefusal(current, new Set(registered));

  expect(refusal).toBeDefined();
  expect(refusal).toContain('/reload');

  for (const tool of missing) {
    expect(refusal).toContain(tool);
  }
});

it('refuses a launch with a fix instruction, not a reload, when the skill tool list could not be read', () => {
  const refusal = skillToolsRefusal(undefined, new Set(['full_check']));

  expect(refusal).toContain('src/skillTools.json');
  expect(refusal).not.toContain('/reload');
});
