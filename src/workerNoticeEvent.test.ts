import { expect, it } from 'vitest';

import { parseWorkerNoticeEvent } from './workerNoticeEvent.js';

it('reads a notice payload', () => {
  expect(parseWorkerNoticeEvent({ worker: 'scout', label: 'asks' })).toEqual({
    worker: 'scout',
    label: 'asks',
  });
});

it.each([undefined, null, 'text', [], {}, { worker: 'scout' }, { worker: 1, label: 'asks' }])(
  'ignores malformed data %j',
  (data) => {
    expect(parseWorkerNoticeEvent(data)).toBeUndefined();
  },
);
