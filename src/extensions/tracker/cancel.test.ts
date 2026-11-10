import { readdir } from 'node:fs/promises';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { cancel } from './cancel.js';

const pullRequest = 'https://github.com/sQVe/tau/pull/42';

afterEach(() => vi.unstubAllEnvs());

it('refuses cancel for a merged PR without a write or confirmation', async () => {
  const directory = await createTemporaryRepository(onTestFinished);
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Merged work', pullRequests: [pullRequest] });
  fake.mergedPullRequests.add(pullRequest);
  const prompts: string[] = [];

  const context = confirmContext(directory, async (title) => {
    prompts.push(title);

    return true;
  });

  await expect(cancel(fake.exec, context, issue.identifier)).rejects.toThrow(pullRequest);

  expect(fake.writes()).toEqual([]);
  expect(issue.state.type).toBe('started');
  expect(prompts).toEqual([]);
  expect(await readdir(directory)).toEqual(['.git']);
});

it('cancels after approval and reads only GitHub PR attachments', async () => {
  const directory = await createTemporaryRepository(onTestFinished);
  const fake = createLinearFake();

  const issue = fake.addIssue({
    title: 'Unused work',
    pullRequests: ['https://example.com/doc', pullRequest],
  });

  const prompts: string[] = [];

  const context = confirmContext(directory, async (_title, message) => {
    prompts.push(message);

    return true;
  });

  expect(await cancel(fake.exec, context, issue.identifier)).toEqual({
    status: 'canceled',
    identifier: issue.identifier,
  });

  expect(issue.state.type).toBe('canceled');

  expect(fake.writes()).toEqual([
    {
      command: 'linear',
      commandArguments: ['issue', 'update', issue.identifier, '--state', 'canceled', '--no-input'],
    },
  ]);

  expect(fake.calls.filter((call) => call.command === 'gh')).toEqual([
    { command: 'gh', commandArguments: ['pr', 'view', pullRequest, '--json', 'state'] },
  ]);

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(issue.identifier);
  expect(prompts[0]).toContain(issue.title);
  expect(prompts[0]).toContain(issue.state.name);
  expect(await readdir(directory)).toEqual(['.git']);
});

it.each(['declined', 'no UI', 'worker', 'already canceled'])(
  'does not cancel when %s',
  async (mode) => {
    const fake = createLinearFake();

    const issue = fake.addIssue({
      title: 'Unused',
      state:
        mode === 'already canceled'
          ? { type: 'canceled', name: 'Canceled' }
          : { type: 'started', name: 'In Progress' },
    });

    const prompts: string[] = [];

    const context =
      mode === 'no UI'
        ? noUiContext('/repo')
        : confirmContext('/repo', async (title) => {
            prompts.push(title);

            return false;
          });

    if (mode === 'worker') {
      vi.stubEnv('TAU_ROLE', 'worker');
    }

    expect(await cancel(fake.exec, context, issue.identifier)).toEqual({
      status: mode === 'already canceled' ? 'unchanged' : 'declined',
      identifier: issue.identifier,
    });

    expect(fake.writes()).toEqual([]);
    expect(prompts).toHaveLength(mode === 'declined' ? 1 : 0);
  },
);

it.each([
  'completed',
  'missing ticket',
  'malformed ticket',
  'failed ticket read',
  'failed PR read',
  'malformed PR',
  'paginated attachments',
  'failed write',
])('refuses cancellation for %s', async (reason) => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Guarded', pullRequests: [pullRequest] });

  if (reason === 'completed') {
    issue.state = { type: 'completed', name: 'Done' };
  }

  if (reason === 'missing ticket') {
    fake.issues.clear();
  }

  if (reason === 'malformed ticket') {
    fake.overrideOutput('attachments(', '{"data":{}}');
  }

  if (reason === 'failed ticket read') {
    fake.failCall('attachments(', 'network error');
  }

  if (reason === 'failed PR read') {
    fake.failCall('pr view', 'network error');
  }

  if (reason === 'malformed PR') {
    fake.overrideOutput('pr view', '{"state":7}');
  }

  if (reason === 'paginated attachments') {
    fake.limitAttachments(0);
  }

  if (reason === 'failed write') {
    fake.failWrite(1);
  }

  const original = structuredClone(issue);
  const prompts: string[] = [];

  const context = confirmContext('/repo', async (title) => {
    prompts.push(title);

    return true;
  });

  await expect(cancel(fake.exec, context, issue.identifier)).rejects.toThrow(
    /completed|no issue|unexpected output|network error|state|another page/,
  );

  expect(fake.writes()).toHaveLength(reason === 'failed write' ? 1 : 0);
  expect(prompts).toHaveLength(reason === 'failed write' ? 1 : 0);
  expect(issue).toEqual(original);
});
