import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { branchFacts } from './branchFacts.js';

const entry = (message: unknown, type = 'message') =>
  ({ type, message }) as unknown as SessionEntry;

const askResult = (answers: unknown[]) =>
  entry({
    role: 'toolResult',
    toolName: 'ask_user_question',
    details: { kind: 'answered', answers },
  });

const assistant = (content: unknown) => entry({ role: 'assistant', content });

it('reports typed when any answer is typed, mixed with selected ones', () => {
  const selected = { question: 'A?', selected: ['x'], typed: false };
  const typed = { question: 'B?', selected: ['y'], typed: true };

  expect(branchFacts([askResult([selected, typed])])).toEqual([{ kind: 'askResult', typed: true }]);
  expect(branchFacts([askResult([typed, selected])])).toEqual([{ kind: 'askResult', typed: true }]);
  expect(branchFacts([askResult([selected])])).toEqual([{ kind: 'askResult', typed: false }]);
});

it.each([
  { name: 'a null block', content: [null] },
  { name: 'a string block', content: ['text'] },
  { name: 'a block of another type with text', content: [{ type: 'thinking', text: 'Reply.' }] },
  { name: 'a text block with a number', content: [{ type: 'text', text: 5 }] },
  { name: 'a text block with a blank string', content: [{ type: 'text', text: ' ' }] },
  { name: 'a text block without text', content: [{ type: 'text' }] },
])('gives no visible text for $name', ({ content }) => {
  expect(branchFacts([assistant(content)])).toEqual([]);
});

it('counts visible text after malformed blocks', () => {
  const content = [null, { type: 'thinking', text: 'x' }, { type: 'text', text: 'Reply.' }];

  expect(branchFacts([assistant(content)])).toEqual([{ kind: 'visibleText' }]);
});

it.each([null, 'text', 5, undefined])(
  'gives no facts for a message entry holding %s',
  (message) => {
    expect(branchFacts([entry(message)])).toEqual([]);
  },
);

it('gives no facts for an entry that is not a message', () => {
  expect(
    branchFacts([entry({ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }, 'custom')]),
  ).toEqual([]);
});

it('does not count visible text from a user message', () => {
  const user = entry({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });

  expect(branchFacts([user])).toEqual([]);
});
