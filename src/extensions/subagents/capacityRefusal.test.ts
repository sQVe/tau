import { expect, it } from 'vitest';

import { capacityRefusalBlock, clearsCapacityRefusal } from './capacityRefusal.js';

it.each([
  { name: 'user message', message: { role: 'user' }, clears: true },
  { name: 'assistant message', message: { role: 'assistant' }, clears: false },
  { name: 'tool result', message: { role: 'toolResult' }, clears: false },
  { name: 'custom message', message: { role: 'custom' }, clears: false },
  {
    name: 'worker report notice',
    message: { role: 'custom', customType: 'tau-worker-report' },
    clears: true,
  },
  {
    name: 'another custom message',
    message: { role: 'custom', customType: 'tau-worker-report-request' },
    clears: false,
  },
])('decides whether $name clears the capacity refusal', ({ message, clears }) => {
  expect(clearsCapacityRefusal(message)).toBe(clears);
});

it.each([
  { refused: false, expected: undefined },
  { refused: true, expected: true },
])('blocks tool calls only when capacity was refused: $refused', ({ refused, expected }) => {
  const result = capacityRefusalBlock(refused);

  expect(result?.block).toBe(expected);
  expect(result?.terminate).toBe(expected);
});
