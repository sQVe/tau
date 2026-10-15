import { expect, it } from 'vitest';

import { briefWithQaLines, qaBriefLines, urlCommandResult } from './qaBrief.js';

const run = { command: './scripts/dev-url', source: '/home/u/tau.json' };

it.each([
  { stdout: 'http://localhost:3000\n', url: 'http://localhost:3000' },
  { stdout: '  https://app.test/path  ', url: 'https://app.test/path' },
])('reads $url from the command output', ({ stdout, url }) => {
  expect(urlCommandResult({ ...run, stdout })).toEqual({ url });
});

it.each([
  { condition: 'the command failed', stdout: undefined },
  { condition: 'the output is empty', stdout: ' \n' },
  { condition: 'the output is not a URL', stdout: 'localhost:3000' },
  { condition: 'the URL is not http', stdout: 'file:///tmp/index.html' },
])('refuses naming the command and the config file when $condition', ({ stdout }) => {
  const result = urlCommandResult({ ...run, stdout });

  const message = 'refusal' in result ? result.refusal : '';

  expect(message).toContain('./scripts/dev-url');
  expect(message).toContain('/home/u/tau.json');
  expect(message).toContain('qa.repositories');
});

it.each([
  {
    settings: { testAccountCommand: 'op read op://dev/cape/login', dataWrites: true },
    lines: [
      'Test account: run `op read op://dev/cape/login` to read it.',
      'Data writes: allowed in the dev database.',
    ],
  },
  {
    settings: { testAccountCommand: undefined, dataWrites: false },
    lines: ['Data writes: not allowed in the dev database.'],
  },
])('writes brief lines for $settings', ({ settings, lines }) => {
  expect(qaBriefLines({ urlCommand: undefined, source: 'tau.json', ...settings })).toEqual(lines);
});

it('appends lines to the brief only when there are some', () => {
  expect(briefWithQaLines('Test it.', [])).toBe('Test it.');
  expect(briefWithQaLines('Test it.', ['A', 'B'])).toBe('Test it.\n\nA\nB');
});
