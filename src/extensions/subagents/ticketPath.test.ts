import { expect, it } from 'vitest';

import { findTicketPath } from './ticketPath.js';

it.for<[string, string, string | undefined]>([
  ['no path', 'Fix the parser.', undefined],
  ['a relative path', 'The task is in .tau/slices/ME-1/agent-1.md', '.tau/slices/ME-1/agent-1.md'],
  [
    'a relative path with ./',
    'Read ./.tau/slices/ME-1/agent-1.md now',
    './.tau/slices/ME-1/agent-1.md',
  ],
  [
    'an absolute path',
    'Read /home/me/code/.tau/slices/ME-1/agent-2.md first',
    '/home/me/code/.tau/slices/ME-1/agent-2.md',
  ],
  [
    'a path in backticks',
    'The task is in `.tau/slices/ME-1/agent-1.md`.',
    '.tau/slices/ME-1/agent-1.md',
  ],
  ['a path in quotes', 'Open ".tau/slices/ME-1/agent-1.md" please', '.tau/slices/ME-1/agent-1.md'],
  [
    'a path followed by a period',
    'See .tau/slices/ME-1/agent-1.md.',
    '.tau/slices/ME-1/agent-1.md',
  ],
  [
    'a path followed by a comma',
    'See .tau/slices/ME-1/agent-1.md, then stop.',
    '.tau/slices/ME-1/agent-1.md',
  ],
  [
    'a path in parentheses',
    'Ticket (.tau/slices/ME-1/agent-1.md) is ready',
    '.tau/slices/ME-1/agent-1.md',
  ],
  [
    'a path in square brackets',
    'Read [.tau/slices/ME-1/agent-1.md]',
    '.tau/slices/ME-1/agent-1.md',
  ],
  ['a nested slice directory', 'Read .tau/slices/a/b/agent-1.md', '.tau/slices/a/b/agent-1.md'],
  [
    'the first of two paths',
    'Read .tau/slices/one/agent-1.md and .tau/slices/two/agent-1.md',
    '.tau/slices/one/agent-1.md',
  ],
  [
    'a dot inside the Markdown filename',
    'Read `.tau/slices/ME-1/agent.md.notes.md`',
    '.tau/slices/ME-1/agent.md.notes.md',
  ],
  ['a markdown file outside slices', 'Read docs/readme.md', undefined],
  ['a slices file that is not markdown', 'Read .tau/slices/ME-1/agent-1.json', undefined],
  ['a longer extension', 'Read .tau/slices/ME-1/agent-1.mdx', undefined],
  ['slices without the .tau segment', 'Read slices/ME-1/agent-1.md', undefined],
])('finds the ticket path for %s', ([, brief, expected]) => {
  expect(findTicketPath(brief)).toBe(expected);
});

// The search runs before the classifier limit can stop it, so it must stay linear in the brief.
it('searches a long brief of slice prefixes without a ticket quickly', () => {
  const brief = '.tau/slices/'.repeat(500);
  const started = performance.now();

  expect(findTicketPath(brief)).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(100);
});
