import { expect, it } from 'vitest';

import { panelVerdict } from './panelVerdict.ts';
import type { MemberResult } from './panelVerdict.ts';

const labels = ['Fast', 'Careful'];

const replied = (text: string): MemberResult => ({ kind: 'replied', text });

const cases = [
  [
    'three recommended replies give 1',
    [replied('Fast'), replied('Fast'), replied('Fast')],
    { kind: 'answered', confidence: 1 },
  ],
  [
    'two of three recommended replies give 2/3',
    [replied('Fast'), replied('Fast'), replied('Careful')],
    { kind: 'answered', confidence: 2 / 3 },
  ],
  [
    'no recommended reply gives 0',
    [replied('Careful'), replied('Careful'), replied('Careful')],
    { kind: 'answered', confidence: 0 },
  ],
  [
    'a reply outside the labels gives error',
    [replied('Other'), replied('Fast'), replied('Fast')],
    { kind: 'error' },
  ],
  [
    'unavailable beats timeout and error',
    [{ kind: 'unavailable' }, { kind: 'timeout' }, { kind: 'error' }],
    { kind: 'unavailable' },
  ],
  [
    'timeout beats error',
    [{ kind: 'timeout' }, { kind: 'error' }, replied('Fast')],
    { kind: 'timeout' },
  ],
  [
    'error beats an answered reply',
    [{ kind: 'error' }, replied('Fast'), replied('Fast')],
    { kind: 'error' },
  ],
  [
    'replies with surrounding spaces match',
    [replied(' Fast '), replied('Fast '), replied(' Fast')],
    { kind: 'answered', confidence: 1 },
  ],
] as const;

it.for(cases)('%s', ([, results, expected]) => {
  expect(panelVerdict(results, labels, 'Fast')).toEqual(expected);
});
