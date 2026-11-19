import { expect, it } from 'vitest';

import { panelVerdict } from './panelVerdict.ts';
import type { MemberResult } from './panelVerdict.ts';

const labels = ['Fast', 'Careful'];

const replied = (text: string): MemberResult => ({ kind: 'replied', text });

const cases = [
  [
    'three recommended replies give 1',
    labels,
    'Fast',
    [replied('Fast'), replied('Fast'), replied('Fast')],
    { kind: 'answered', confidence: 1 },
  ],
  [
    'two of three recommended replies give 2/3',
    labels,
    'Fast',
    [replied('Fast'), replied('Fast'), replied('Careful')],
    { kind: 'answered', confidence: 2 / 3 },
  ],
  [
    'no recommended reply gives 0',
    labels,
    'Fast',
    [replied('Careful'), replied('Careful'), replied('Careful')],
    { kind: 'answered', confidence: 0 },
  ],
  [
    'a reply outside the labels gives error',
    labels,
    'Fast',
    [replied('Other'), replied('Fast'), replied('Fast')],
    { kind: 'error' },
  ],
  [
    'unavailable beats timeout and error',
    labels,
    'Fast',
    [{ kind: 'unavailable' }, { kind: 'timeout' }, { kind: 'error' }],
    { kind: 'unavailable' },
  ],
  [
    'timeout beats error',
    labels,
    'Fast',
    [{ kind: 'timeout' }, { kind: 'error' }, replied('Fast')],
    { kind: 'timeout' },
  ],
  [
    'error beats an answered reply',
    labels,
    'Fast',
    [{ kind: 'error' }, replied('Fast'), replied('Fast')],
    { kind: 'error' },
  ],
  [
    'replies with surrounding spaces match',
    labels,
    'Fast',
    [replied(' Fast '), replied('Fast '), replied(' Fast')],
    { kind: 'answered', confidence: 1 },
  ],
  [
    'a padded recommended label counts exact replies as support',
    ['Fast ', 'Careful'],
    'Fast ',
    [replied('Fast'), replied('Fast'), replied('Fast')],
    { kind: 'answered', confidence: 1 },
  ],
  [
    'two option labels that trim to the same text give error',
    ['Fast ', 'Fast'],
    'Fast ',
    [replied('Fast'), replied('Fast'), replied('Fast')],
    { kind: 'error' },
  ],
] as const;

it.for(cases)('%s', ([, rowLabels, recommended, results, expected]) => {
  expect(panelVerdict(results, rowLabels, recommended)).toEqual(expected);
});
