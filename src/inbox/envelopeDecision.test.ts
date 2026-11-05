import { expect, it } from 'vitest';

import { judgeEnvelopeIdentity } from './envelopeDecision.js';

const expected = { messageId: 'm1', terminal: 't7' };

it.each([
  {
    case: 'a matching identity',
    identity: { filenameMessageId: 'm1', envelopeMessageId: 'm1', targetTerminal: 't7' },
    kind: 'accept',
  },
  {
    case: 'a filename mismatch',
    identity: { filenameMessageId: 'm2', envelopeMessageId: 'm1', targetTerminal: 't7' },
    kind: 'refuse',
  },
  {
    case: 'an envelope id mismatch',
    identity: { filenameMessageId: 'm1', envelopeMessageId: 'm2', targetTerminal: 't7' },
    kind: 'refuse',
  },
  {
    case: 'another target terminal',
    identity: { filenameMessageId: 'm1', envelopeMessageId: 'm1', targetTerminal: 't8' },
    kind: 'refuse',
  },
])('judges $case as $kind', ({ identity, kind }) => {
  expect(judgeEnvelopeIdentity(identity, expected).kind).toBe(kind);
});
