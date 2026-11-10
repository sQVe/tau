import { expect, it } from 'vitest';

import { sameDescription } from './descriptionMatch.js';

it.each<{
  name: string;
  saved: string;
  body: string | undefined;
  expected: boolean;
}>([
  {
    name: 'matches a star list marker against a dash marker',
    saved: '* one',
    body: '- one',
    expected: true,
  },
  {
    name: 'matches an indented star marker against an indented dash marker',
    saved: '  * two',
    body: '  - two',
    expected: true,
  },
  {
    name: 'does not treat a dash inside text as a list marker',
    saved: 'keep * dash',
    body: 'keep - dash',
    expected: false,
  },
  {
    name: 'does not match a changed marker inside a backtick fence',
    saved: '```\n* one\n```',
    body: '```\n- one\n```',
    expected: false,
  },
  {
    name: 'does not match a changed marker inside a tilde fence',
    saved: '~~~\n* one\n~~~',
    body: '~~~\n- one\n~~~',
    expected: false,
  },
  {
    name: 'matches markers outside a fence when the fenced text is equal',
    saved: '* one\n```\n* code\n```',
    body: '- one\n```\n* code\n```',
    expected: true,
  },
  {
    name: 'does not close a four-backtick fence with a three-backtick line',
    saved: '````\n```\n* a\n````',
    body: '````\n```\n- a\n````',
    expected: false,
  },
  {
    name: 'closes a fence with a closing line that has trailing spaces',
    saved: '```\n* a\n```   \n* b',
    body: '```\n* a\n```   \n- b',
    expected: true,
  },
  {
    name: 'never matches a missing body',
    saved: '',
    body: undefined,
    expected: false,
  },
  {
    name: 'counts a missing final newline as a different description',
    saved: 'one\n',
    body: 'one',
    expected: false,
  },
])('$name', ({ saved, body, expected }) => {
  expect(sameDescription(saved, body)).toBe(expected);
});
