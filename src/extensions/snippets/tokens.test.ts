import { describe, expect, it } from 'vitest';

import {
  acceptsSnippets,
  activeSnippets,
  expandSnippets,
  mayHoldTokens,
  snippetQueryAt,
} from './tokens.js';
import type { Snippet } from './types.js';

const createSnippet = (id: string, body: string): Snippet => ({
  id,
  name: id,
  description: '',
  order: 10,
  body,
});

const snippets = [
  createSnippet('push-back', 'Push back.'),
  createSnippet('verify', 'Verify.'),
  createSnippet('simplify', 'Simplify.'),
];

describe('expandSnippets', () => {
  it.each([
    { text: '#push-back Ship it.', sent: 'Push back.\n\nShip it.' },
    { text: 'Ship it. #simplify', sent: 'Ship it.\n\nSimplify.' },
    { text: 'Ship #simplify it.', sent: 'Ship\n\nSimplify.\n\nit.' },
    {
      text: 'Review the plan #push-back and keep it short #simplify',
      sent: 'Review the plan\n\nPush back.\n\nand keep it short\n\nSimplify.',
    },
    { text: '#simplify #push-back Ship it.', sent: 'Simplify.\n\nPush back.\n\nShip it.' },
    { text: '#verify Ship it. #push-back', sent: 'Verify.\n\nShip it.\n\nPush back.' },
    { text: '#simplify Ship it. #simplify', sent: 'Simplify.\n\nShip it.' },
    { text: 'Ship #simplify it #simplify now.', sent: 'Ship\n\nSimplify.\n\nit now.' },
    { text: '#push-back #simplify', sent: 'Push back.\n\nSimplify.' },
    { text: '  #push-back\n', sent: 'Push back.' },
    { text: '#push-back\nShip it.', sent: 'Push back.\n\nShip it.' },
    { text: 'First.\n\n#verify\n\nSecond.', sent: 'First.\n\nVerify.\n\nSecond.' },
    { text: 'Ship it (#simplify).', sent: 'Ship it (\n\nSimplify.\n\n).' },
    { text: 'Ship it.\t#simplify\nThen rest.', sent: 'Ship it.\n\nSimplify.\n\nThen rest.' },
    {
      text: 'Review #simplify\n    if ready:\n        ship()',
      sent: 'Review\n\nSimplify.\n\n    if ready:\n        ship()',
    },
    {
      text: 'Review #simplify #simplify\n\n    if ready:\n        ship()',
      sent: 'Review\n\nSimplify.\n\n    if ready:\n        ship()',
    },
    { text: 'Fix #123 now. #simplify', sent: 'Fix #123 now.\n\nSimplify.' },
    { text: '# Heading\n#simplify', sent: '# Heading\n\nSimplify.' },
    { text: 'Use `#simplify` here. #verify', sent: 'Use `#simplify` here.\n\nVerify.' },
    { text: 'Use ``a ` #simplify`` here. #verify', sent: 'Use ``a ` #simplify`` here.\n\nVerify.' },
    {
      text: '#verify\n```md\n#simplify\n```\nDone.',
      sent: 'Verify.\n\n```md\n#simplify\n```\nDone.',
    },
    { text: '#verify\n~~~\n#simplify', sent: 'Verify.\n\n~~~\n#simplify' },
    { text: 'Unclosed `#simplify', sent: 'Unclosed `\n\nSimplify.' },
    { text: '` x `` y `` #simplify ` #verify', sent: '` x `` y `` #simplify `\n\nVerify.' },
  ])('sends $text as $sent', ({ text, sent }) => {
    expect(expandSnippets(text, snippets)).toBe(sent);
  });

  it.each([
    'Ship it.',
    'Fix #123 and #unknown.',
    '# Heading',
    'Mail a#simplify or x#verify',
    'Use `#simplify` here.',
    '```\n#simplify\n```',
    '/skill:commit #simplify',
    '  /my-template #push-back',
  ])('leaves %s unchanged', (text) => {
    expect(expandSnippets(text, snippets)).toBeUndefined();
  });

  it('expands a token after CJK punctuation, as the editor boundary does', () => {
    expect(expandSnippets('完成，#simplify', snippets)).toBe('完成，\n\nSimplify.');
  });
});

describe('activeSnippets', () => {
  it('lists each known token once, in token order', () => {
    const active = activeSnippets('#simplify #verify #push-back #simplify #nope', snippets);

    expect(active.map((snippet) => snippet.id)).toEqual(['simplify', 'verify', 'push-back']);
  });

  it('lists nothing for a slash command', () => {
    expect(activeSnippets('/skill:commit #simplify', snippets)).toEqual([]);
  });
});

describe('mayHoldTokens', () => {
  it.each([
    { text: 'Fix #123.', holds: true },
    { text: '#anything', holds: true },
    { text: 'Ship it.', holds: false },
    { text: '# Heading', holds: false },
    { text: 'Use `#simplify`.', holds: false },
    { text: '/skill:commit #simplify', holds: false },
  ])('reads $text as holding tokens: $holds', ({ text, holds }) => {
    expect(mayHoldTokens(text)).toBe(holds);
  });
});

describe('snippetQueryAt', () => {
  it.each([
    { text: '#sim', offset: 4, query: 'sim' },
    { text: 'Ship #push-b', offset: 12, query: 'push-b' },
    { text: 'Ship (#sim', offset: 10, query: 'sim' },
    { text: 'Ship\n#sim later', offset: 9, query: 'sim' },
    { text: 'Ship `#sim', offset: 10, query: 'sim' },
    { text: '#', offset: 1, query: '' },
    { text: 'Ship (#', offset: 7, query: '' },
  ])('reads $query from $text', ({ text, offset, query }) => {
    expect(snippetQueryAt(text, offset)).toBe(query);
  });

  it.each([
    { text: '# ', offset: 2 },
    { text: 'a#sim', offset: 5 },
    { text: '#sim.', offset: 5 },
    { text: 'Ship it', offset: 7 },
    { text: '`#sim` here', offset: 5 },
    { text: '```\n#sim', offset: 8 },
  ])('reads no query from $text at $offset', ({ text, offset }) => {
    expect(snippetQueryAt(text, offset)).toBeUndefined();
  });
});

describe('acceptsSnippets', () => {
  it.for(['/skill:commit', '/commit stage the fix', '  /skill:commit', '/my-prompt-template'])(
    'refuses the slash command %s',
    (text) => {
      expect(acceptsSnippets(text)).toBe(false);
    },
  );

  it.for(['Commit the fix.', 'Look at src/a.ts', 'Use the / operator here.'])(
    'accepts %s',
    (text) => {
      expect(acceptsSnippets(text)).toBe(true);
    },
  );
});
