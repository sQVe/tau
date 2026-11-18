import { expect, it } from 'vitest';

import type { RoleKind } from '../../role/role.js';
import { skillToolsRefusal } from './skillToolsRefusal.js';

const allowedCases: readonly {
  case: string;
  role: RoleKind;
  current: Record<string, readonly string[]>;
  registered: readonly string[];
}[] = [
  {
    case: 'every listed tool is registered',
    role: 'lead',
    current: { tdd: ['full_check'] },
    registered: ['full_check'],
  },
  {
    case: 'one tool is listed under two skills and registered',
    role: 'lead',
    current: { tdd: ['slice'], pr: ['slice'] },
    registered: ['slice'],
  },
  {
    case: 'a registered tool is not listed',
    role: 'lead',
    current: { tdd: ['full_check'] },
    registered: ['full_check', 'read'],
  },
];

it.each(allowedCases)('allows a launch when $case', ({ role, current, registered }) => {
  expect(skillToolsRefusal(current, new Set(registered), role)).toBeUndefined();
});

it('skips a listed tool the role never registers', () => {
  const refusal = skillToolsRefusal(
    { slice: ['slice', 'architect'] },
    new Set(['slice']),
    'architect',
  );

  expect(refusal).toBeUndefined();
});

const occurrences = (text: string, value: string): number => text.split(value).length - 1;

const refusalCases: readonly {
  case: string;
  role: RoleKind;
  current: Record<string, readonly string[]>;
  registered: readonly string[];
  missing: readonly string[];
  absent: readonly string[];
  exactlyOnce?: readonly string[];
}[] = [
  {
    case: 'one listed tool is not registered',
    role: 'lead',
    current: { tdd: ['full_check', 'mutation_check'] },
    registered: ['full_check'],
    missing: ['mutation_check'],
    absent: [],
  },
  {
    case: 'two listed tools are not registered',
    role: 'lead',
    current: { tdd: ['mutation_check'], 'pr-feedback': ['pr_feedback'] },
    registered: [],
    missing: ['mutation_check', 'pr_feedback'],
    absent: [],
  },
  {
    case: 'a tool is missing under two skills',
    role: 'lead',
    current: { tdd: ['mutation_check'], pr: ['mutation_check'] },
    registered: [],
    missing: ['mutation_check'],
    absent: [],
    exactlyOnce: ['mutation_check'],
  },
  {
    case: 'the lead does not register the architect tool',
    role: 'lead',
    current: { slice: ['architect'] },
    registered: [],
    missing: ['architect'],
    absent: [],
  },
  {
    case: 'the architect does not register a listed mutation tool',
    role: 'architect',
    current: { tdd: ['mutation_check', 'architect'] },
    registered: [],
    missing: ['mutation_check'],
    absent: ['architect'],
  },
  {
    case: 'an inherited name is missing',
    role: 'lead',
    current: { tdd: ['constructor'] },
    registered: [],
    missing: ['constructor'],
    absent: [],
  },
];

it.each(refusalCases)(
  'refuses a launch and names the tools when $case',
  ({ role, current, registered, missing, absent, exactlyOnce }) => {
    const refusal = skillToolsRefusal(current, new Set(registered), role);

    expect(refusal).toBeDefined();
    expect(refusal).toContain('/reload');

    for (const tool of missing) {
      expect(refusal).toContain(tool);
    }

    for (const tool of absent) {
      expect(refusal).not.toContain(tool);
    }

    for (const tool of exactlyOnce ?? []) {
      expect(occurrences(refusal ?? '', tool)).toBe(1);
    }
  },
);

it('refuses a launch with a fix instruction, not a reload, when the skill tool list could not be read', () => {
  const refusal = skillToolsRefusal(undefined, new Set(['full_check']), 'lead');

  expect(refusal).toContain('src/skillTools.json');
  expect(refusal).not.toContain('/reload');
});
