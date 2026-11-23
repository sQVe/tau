import { expect, it } from 'vitest';

import { gateRoutingQuestion } from './gateQuestion.js';

it.for([
  ['a plain request', 'Rename the flag.', 'Rename --fast to --quick.'],
  [
    'a multi-line request with quotes',
    'Merge PR #91.\nWait for "green" checks.',
    'Merge the PR once every check passes.',
  ],
  ['an empty restatement', 'Continue.', ''],
] as const)('holds the request and restatement verbatim for %s', ([, request, restatement]) => {
  const question = gateRoutingQuestion({ request, restatement });

  expect(question).toContain(request);
  expect(question).toContain(restatement);
  expect(question).toContain('Worker:');
  expect(question).toContain('Open the architect:');
});
