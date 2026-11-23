import type { GateRecord } from '../record.js';

export const gateRoutingQuestion = (record: Pick<GateRecord, 'request' | 'restatement'>): string =>
  [
    'The architect gate could not classify this request with confidence. Decide how Tau routes it.',
    '',
    'Request:',
    record.request,
    '',
    'Restatement:',
    record.restatement,
    '',
    'Answer with exactly one of these two prefixes:',
    '- Worker: <notes for the worker brief>, when no design choice is open.',
    '- Open the architect: <reason>, when a design choice, research, or the user is needed.',
    'Start the answer with one of the two prefixes, even after you talk to the user.',
  ].join('\n');
