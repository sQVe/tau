import type { SessionStartEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { refillsHistory, sentPromptTexts } from './history.js';

it.each<{ reason: SessionStartEvent['reason']; refills: boolean }>([
  { reason: 'startup', refills: false },
  { reason: 'new', refills: false },
  { reason: 'resume', refills: true },
  { reason: 'fork', refills: true },
  { reason: 'reload', refills: true },
])('refills history after $reason: $refills', ({ reason, refills }) => {
  expect(refillsHistory(reason)).toBe(refills);
});

it('lists the text of user messages, oldest first, from string and block content', () => {
  const messages = [
    { role: 'user', content: 'plain prompt', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'one ' },
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'text', text: 'two' },
      ],
      timestamp: 3,
    },
    { role: 'user', content: '', timestamp: 4 },
  ] as unknown as Parameters<typeof sentPromptTexts>[0];

  expect(sentPromptTexts(messages)).toEqual(['plain prompt', 'one two']);
});
