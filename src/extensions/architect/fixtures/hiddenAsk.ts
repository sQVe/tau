import type { HiddenAskRecord } from '../record.js';

export const hiddenIds = {
  running: '0190c1d2-0000-7000-8000-000000000301',
  sent: '0190c1d2-0000-7000-8000-000000000302',
} as const;

export const hiddenAsk = (
  name: keyof typeof hiddenIds,
  status: HiddenAskRecord['status'],
): HiddenAskRecord => ({
  version: 2,
  route: 'hidden',
  askId: hiddenIds[name],
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status,
  detail: null,
  answer: null,
});
