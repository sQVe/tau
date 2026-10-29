import { expect, it, onTestFinished, vi } from 'vitest';

import { parseSkillTools } from './skillTools.js';

it.each([
  {
    case: 'a valid mapping',
    text: '{"tdd": ["mutation_check"], "pr": ["pr", "full_check"]}',
    expected: { tdd: ['mutation_check'], pr: ['pr', 'full_check'] },
  },
  {
    case: 'an empty list for a skill',
    text: '{"handover": []}',
    expected: { handover: [] },
  },
  {
    case: 'an empty object',
    text: '{}',
    expected: {},
  },
  {
    case: 'a skill named like an object prototype property',
    text: '{"__proto__": ["full_check"]}',
    expected: Object.fromEntries([['__proto__', ['full_check']]]),
  },
  {
    case: 'invalid JSON',
    text: '{"tdd": ["mutation_check"],}',
    expected: undefined,
  },
  {
    case: 'an empty file',
    text: '',
    expected: undefined,
  },
  {
    case: 'a top-level array',
    text: '[{"tdd": ["mutation_check"]}]',
    expected: undefined,
  },
  {
    case: 'null',
    text: 'null',
    expected: undefined,
  },
  {
    case: 'a top-level string',
    text: '"tdd"',
    expected: undefined,
  },
  {
    case: 'a non-array value',
    text: '{"tdd": "mutation_check"}',
    expected: undefined,
  },
  {
    case: 'a nested object as a value',
    text: '{"tdd": {"mutation_check": true}}',
    expected: undefined,
  },
  {
    case: 'a non-string item',
    text: '{"tdd": ["mutation_check", 3]}',
    expected: undefined,
  },
  {
    case: 'a null item',
    text: '{"tdd": [null]}',
    expected: undefined,
  },
  {
    case: 'a nested array item',
    text: '{"tdd": [["mutation_check"]]}',
    expected: undefined,
  },
])('parses skillTools from $case', ({ text, expected }) => {
  expect(parseSkillTools(text)).toEqual(expected);
});

it('throws at startup when the bundled skill tool file is invalid', async () => {
  vi.resetModules();

  onTestFinished(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  vi.doMock(import('node:fs'), () => ({ readFileSync: () => '[]' as never }));

  await expect(import('./skillTools.js')).rejects.toThrow(
    'must map each skill name to a list of tool names',
  );
});
