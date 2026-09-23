import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it, onTestFinished as registerCleanup, vi } from 'vitest';

import { createHarness, createWorktree } from './tddHarness.js';

vi.setConfig({ testTimeout: 125_000 });

it('keeps actual test failures when a sibling bash edits inputs during the run', async ({
  onTestFinished,
}) => {
  const { cwd, session, faux, events } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { writeFile } from 'node:fs/promises'; it('required behavior', async () => { await writeFile('started', ''); await new Promise(r => setTimeout(r, 500)); expect(1).toBe(2); });",
  );
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('run_tests', {
        behavior: 'required behavior',
        testFullName: 'required behavior',
        files: ['behavior.test.ts'],
        scope: 'focused',
      }),
      fauxToolCall('bash', {
        command:
          "while [ ! -f started ]; do sleep 0.02; done; printf 'export default { test: {} };' > vite.config.ts",
      }),
    ]),
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Run and edit concurrently.');

  const result = events.find(
    (event) => event.type === 'tool_execution_end' && event.toolName === 'run_tests',
  );

  expect(result).toMatchObject({
    isError: false,
    result: {
      details: {
        kind: 'fail',
        freshness: 'stale',
        report: { kind: 'fail', tests: [{ status: 'failed' }] },
      },
    },
  });
});

it('serializes overlapping calls through pi', async ({ onTestFinished }) => {
  const { cwd, session, faux, events } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; import { appendFile } from 'node:fs/promises'; it('required behavior', async () => { await appendFile('order', 'start\\n'); await new Promise(r => setTimeout(r, 100)); await appendFile('order', 'end\\n'); });",
  );
  const parameters = {
    behavior: 'required behavior',
    testFullName: 'required behavior',
    files: ['behavior.test.ts'],
    scope: 'focused',
  };
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('run_tests', parameters),
      fauxToolCall('run_tests', parameters),
    ]),
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Run twice concurrently.');

  expect(
    events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'run_tests'),
  ).toHaveLength(2);
  expect(await readFile(join(cwd, 'order'), 'utf8')).toBe('start\nend\nstart\nend\n');
});

it.each(['../outside.test.ts', 'src/value.ts', '/absolute.test.ts', '*.test.ts'])(
  'rejects invalid test paths through Pi: %s',
  async (file) => {
    const { call } = await createHarness(registerCleanup);
    const result = await call('run_tests', {
      behavior: 'behavior',
      testFullName: 'required',
      files: [file],
      scope: 'focused',
    });

    expect(result.isError).toBe(true);
  },
);

it('selects exact nested names including regular expression characters through a symlinked worktree', async ({
  onTestFinished,
}) => {
  const cwd = await createWorktree(onTestFinished);
  const alias = `${cwd}-alias`;

  await symlink(cwd, alias, 'dir');
  onTestFinished(() => rm(alias, { force: true }));
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { describe, it } from 'vitest'; describe('outer', () => { it('works (1)+', () => {}); it('works 11', () => { throw Error('not selected'); }); });",
  );

  const { run } = await createHarness(onTestFinished, [], alias);
  const result = await run({ testFullName: ['outer works (1)+'] });

  expect(result.details.report).toMatchObject({
    kind: 'pass',
    tests: [{ fullname: 'outer works (1)+', status: 'passed' }],
  });
  expect(result.details.report).toHaveProperty('tests.length', 1);
});
