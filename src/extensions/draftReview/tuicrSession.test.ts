import { expect, it } from 'vitest';

import { listSessionPaths, readSessionComments } from './tuicrSession.js';

const answering = (output: string) => async () => output;

const comment = {
  id: 'one',
  path: 'a.md',
  start_line: 1,
  end_line: 2,
  comment_type: 'issue',
  content: 'fix',
};

it('reads the session paths tuicr lists', async () => {
  const paths = await listSessionPaths(answering('[{"path":"/s/one.json"}]'), '/staging');

  expect(paths).toEqual(['/s/one.json']);
});

it.each(['[{"path":""}]', '[{}]', '[{"path":1}]', '{"path":"/s"}'])(
  'refuses the session list %s',
  async (output) => {
    await expect(listSessionPaths(answering(output), '/staging')).rejects.toThrow(
      /unexpected session list/,
    );
  },
);

it('reads the comments tuicr prints', async () => {
  const comments = await readSessionComments(answering(JSON.stringify([comment])), '/s');

  expect(comments).toEqual([
    { id: 'one', path: 'a.md', startLine: 1, endLine: 2, type: 'issue', content: 'fix' },
  ]);
});

it.each([{ id: '' }, { id: undefined }, { content: undefined }, { start_line: undefined }])(
  'refuses a comment with %j',
  async (change) => {
    const output = JSON.stringify([{ ...comment, ...change }]);

    await expect(readSessionComments(answering(output), '/s')).rejects.toThrow(
      /unexpected comments/,
    );
  },
);
