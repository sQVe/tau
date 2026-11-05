import { expect, it } from 'vitest';

import { summarize } from './render.js';
import type { RunnerResult, TestFailure } from './runner/types.js';

const observation = (failures: TestFailure[]): Parameters<typeof summarize>[1] => {
  const report: RunnerResult = { kind: 'fail', tests: [], failures, truncated: false };

  return {
    kind: report.kind,
    scope: 'focused',
    freshness: 'fresh',
    inputs: { before: 'before', after: 'after' },
    runPath: undefined,
    report,
  };
};

it.for<{ name: string; attribution: TestFailure['attribution']; text: string }>([
  {
    name: 'an unknown result',
    attribution: { kind: 'unknown', reason: 'no dep-info' },
    text: '[attribution unknown: no dep-info]',
  },
  {
    name: 'an ambiguous result',
    attribution: { kind: 'ambiguous', binaryIds: ['demo', 'demo::bin/demo'] },
    text: '[ambiguous: demo, demo::bin/demo]',
  },
  {
    name: 'an ambiguous result for several requested files',
    attribution: { kind: 'ambiguous', binaryIds: ['demo'], files: ['src/a.rs', 'src/b.rs'] },
    text: '[ambiguous: src/a.rs, src/b.rs]',
  },
])('shows $name next to its failure', ({ attribution, text }) => {
  const failures: TestFailure[] = [
    {
      file: '',
      fullname: 'sub::tests::fails',
      message: 'boom',
      ...(attribution === undefined ? {} : { attribution }),
    },
  ];

  expect(summarize('/repo', observation(failures))).toContain(text);
});

it('leaves an exact failure without an attribution note', () => {
  const failures: TestFailure[] = [
    { file: 'src/sub.rs', fullname: 'sub::tests::fails', message: 'boom' },
  ];

  const text = summarize('/repo', observation(failures));

  expect(text).toContain('✗ src/sub.rs › sub::tests::fails');
  expect(text).not.toContain('[attribution');
  expect(text).not.toContain('[ambiguous');
});
