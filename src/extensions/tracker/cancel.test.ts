import { readdir } from 'node:fs/promises';

import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { cancel } from './cancel.js';
import {
  answer,
  askCall,
  askResult,
  cancelOption,
  question,
  user,
} from './fixtures/approvedPreview.js';

interface AnswerFacts {
  selected?: string[];
  typed?: boolean;
}

type NonClosingLink = { mentions: string[] } | { plainLinks: string[] };

const pullRequest = 'https://github.com/sQVe/tau/pull/42';

afterEach(() => vi.unstubAllEnvs());

const answeredBranch = (
  options: readonly unknown[],
  { selected = answer.selected, typed = answer.typed }: AnswerFacts = {},
  questionOverrides: Parameters<typeof question>[1] = {},
  resultOverrides: Record<string, unknown> = {},
) => [
  askCall('call-1', [question(options, questionOverrides)]),
  askResult('call-1', [{ ...answer, selected, typed }], resultOverrides),
];

const approvalBranch = (identifier: string, preview = `Cancel ${identifier}: Title`) =>
  answeredBranch([cancelOption(preview)]);

const branchContext = (
  branch: SessionEntry[],
  confirm: (title: string, message: string) => Promise<boolean>,
): ExtensionContext => {
  const context = confirmContext('/repo', confirm);

  return {
    ...context,
    sessionManager: { ...context.sessionManager, getBranch: () => branch },
  };
};

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

const nonClosingLinks: [string, NonClosingLink][] = [
  ['only mentions it', { mentions: [pullRequest] }],
  ['carries no link kind', { plainLinks: [pullRequest] }],
];

it.each(nonClosingLinks)('cancels a ticket whose merged PR %s', async (_case, links) => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Mentioned work', ...links });
  fake.mergedPullRequests.add(pullRequest);
  const prompts: string[] = [];

  const context = confirmContext('/repo', async (title) => {
    prompts.push(title);

    return true;
  });

  expect(await cancel(fake.exec, context, issue.identifier)).toEqual({
    status: 'canceled',
    identifier: issue.identifier,
  });

  expect(issue.state.type).toBe('canceled');
  expect(prompts).toHaveLength(1);
  expect(fake.calls.filter((call) => call.command === 'gh')).toEqual([]);
});

it('refuses cancellation when a linked PR merges during confirmation', async () => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Work in review', pullRequests: [pullRequest] });

  const context = confirmContext('/repo', async () => {
    fake.mergedPullRequests.add(pullRequest);

    return true;
  });

  await expect(cancel(fake.exec, context, issue.identifier)).rejects.toThrow(pullRequest);

  expect(fake.writes()).toEqual([]);
  expect(issue.state.type).toBe('started');
});

it('refuses cancellation when the ticket completes during confirmation', async () => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Work in progress' });

  const context = confirmContext('/repo', async () => {
    issue.state = { type: 'completed', name: 'Done' };

    return true;
  });

  await expect(cancel(fake.exec, context, issue.identifier)).rejects.toThrow('completed');

  expect(fake.writes()).toEqual([]);
  expect(issue.state.type).toBe('completed');
});

it.each(['title', 'state'])(
  'refuses cancellation when the %s changes during confirmation',
  async (field) => {
    const fake = createLinearFake();
    const issue = fake.addIssue({ title: 'Work in progress' });

    const context = confirmContext('/repo', async () => {
      if (field === 'title') {
        issue.title = 'Different work';
      } else {
        issue.state = { type: 'started', name: 'In Review' };
      }

      return true;
    });

    const result = cancel(fake.exec, context, issue.identifier);

    await expect(result).rejects.toThrow(`${field} changed`);
    await expect(result).rejects.toThrow('Nothing was written');
    expect(fake.writes()).toEqual([]);
  },
);

it('returns unchanged when the ticket is canceled during confirmation', async () => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Work in progress' });

  const context = confirmContext('/repo', async () => {
    issue.state = { type: 'canceled', name: 'Canceled' };

    return true;
  });

  expect(await cancel(fake.exec, context, issue.identifier)).toEqual({
    status: 'unchanged',
    identifier: issue.identifier,
  });

  expect(fake.writes()).toEqual([]);
});

it('refuses cancellation when a merged PR is attached during confirmation', async () => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Work in progress' });
  fake.mergedPullRequests.add(pullRequest);

  const context = confirmContext('/repo', async () => {
    issue.pullRequests.push(pullRequest);

    return true;
  });

  await expect(cancel(fake.exec, context, issue.identifier)).rejects.toThrow(pullRequest);

  expect(fake.writes()).toEqual([]);
  expect(issue.state.type).toBe('started');
});

it.each(['ticket', 'PR'])(
  'refuses cancellation when the %s reread fails after confirmation',
  async (failedRead) => {
    const fake = createLinearFake();
    const issue = fake.addIssue({ title: 'Work in progress', pullRequests: [pullRequest] });
    const key = failedRead === 'ticket' ? 'attachments(' : 'pr view';

    const context = confirmContext('/repo', async () => {
      fake.failCall(key, 'network error');

      return true;
    });

    await expect(cancel(fake.exec, context, issue.identifier)).rejects.toThrow('network error');

    expect(fake.writes()).toEqual([]);
    expect(issue.state.type).toBe('started');
  },
);

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
    { command: 'gh', commandArguments: ['pr', 'view', pullRequest, '--json', 'state'] },
  ]);

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(issue.identifier);
  expect(prompts[0]).toContain(issue.title);
  expect(prompts[0]).toContain('Current state: In Progress');
  expect(await readdir(directory)).toEqual(['.git']);
});

it.each(['declined', 'no UI', 'worker', 'already canceled'])(
  'does not cancel when %s',
  async (mode) => {
    const fake = createLinearFake();

    const issueState =
      mode === 'already canceled'
        ? ({ type: 'canceled', name: 'Canceled' } as const)
        : ({ type: 'started', name: 'In Progress' } as const);

    const issue = fake.addIssue({
      title: 'Unused',
      state: issueState,
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

    const expectedStatus = mode === 'already canceled' ? 'unchanged' : 'declined';

    expect(await cancel(fake.exec, context, issue.identifier)).toEqual({
      status: expectedStatus,
      identifier: issue.identifier,
    });

    expect(fake.writes()).toEqual([]);
    const promptCount = mode === 'declined' ? 1 : 0;
    expect(prompts).toHaveLength(promptCount);
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

  const writeCount = reason === 'failed write' ? 1 : 0;
  expect(fake.writes()).toHaveLength(writeCount);
  const promptCount = reason === 'failed write' ? 1 : 0;
  expect(prompts).toHaveLength(promptCount);
  expect(issue).toEqual(original);
});

it('cancels without a dialog when an answered preview lists the ticket', async () => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Unused work', identifier: 'ME-1' });
  const prompts: string[] = [];

  const context = branchContext(approvalBranch(issue.identifier), async (title) => {
    prompts.push(title);

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

  expect(prompts).toEqual([]);
});

it('cancels only the selected previews of a multi-select answer', async () => {
  const fake = createLinearFake();
  const first = fake.addIssue({ title: 'First', identifier: 'ME-1' });
  const second = fake.addIssue({ title: 'Second', identifier: 'ME-2' });
  const third = fake.addIssue({ title: 'Third', identifier: 'ME-3' });
  const prompts: string[] = [];

  const branch = answeredBranch(
    [
      { label: 'Cancel first', preview: 'Cancel ME-1: First' },
      { label: 'Cancel second', preview: 'Cancel ME-2: Second' },
      { label: 'Cancel third', preview: 'Cancel ME-3: Third' },
    ],
    { selected: ['Cancel first', 'Cancel second'] },
    { multiSelect: true },
  );

  const context = branchContext(branch, async (title) => {
    prompts.push(title);

    return false;
  });

  expect(await cancel(fake.exec, context, first.identifier)).toEqual({
    status: 'canceled',
    identifier: first.identifier,
  });

  expect(await cancel(fake.exec, context, second.identifier)).toEqual({
    status: 'canceled',
    identifier: second.identifier,
  });

  expect(await cancel(fake.exec, context, third.identifier)).toEqual({
    status: 'declined',
    identifier: third.identifier,
  });

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(third.identifier);

  expect(fake.writes()).toEqual([
    {
      command: 'linear',
      commandArguments: ['issue', 'update', first.identifier, '--state', 'canceled', '--no-input'],
    },
    {
      command: 'linear',
      commandArguments: ['issue', 'update', second.identifier, '--state', 'canceled', '--no-input'],
    },
  ]);

  expect(first.state.type).toBe('canceled');
  expect(second.state.type).toBe('canceled');
  expect(third.state.type).toBe('started');
});

it('declines without a UI even when the branch holds an eligible approval', async () => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Unused work', identifier: 'ME-1' });
  const base = noUiContext('/repo');

  const context = {
    ...base,
    sessionManager: { ...base.sessionManager, getBranch: () => approvalBranch(issue.identifier) },
  };

  expect(await cancel(fake.exec, context, issue.identifier)).toEqual({
    status: 'declined',
    identifier: issue.identifier,
  });

  expect(fake.writes()).toEqual([]);
  expect(issue.state.type).toBe('started');
});

const nonApprovalBranches = (identifier: string) => [
  { name: 'no branch', branch: [] },
  { name: 'another ticket', branch: approvalBranch(identifier, 'Cancel ME-999: Title') },
  {
    name: 'a Keep answer',
    branch: answeredBranch(
      [{ label: 'Keep' }],
      { selected: ['Keep'] },
      { preview: `Cancel ${identifier}: Title` },
    ),
  },
  {
    name: 'a typed answer',
    branch: answeredBranch([cancelOption(`Cancel ${identifier}: Title`)], {
      typed: true,
    }),
  },
  {
    name: 'an approval before the latest user message',
    branch: [...approvalBranch(identifier), user()],
  },
  {
    name: 'a decided result',
    branch: answeredBranch(
      [cancelOption(`Cancel ${identifier}: Title`)],
      {},
      {},
      {
        details: { kind: 'decided', answers: [answer] },
      },
    ),
  },
  {
    name: 'an error result',
    branch: answeredBranch(
      [cancelOption(`Cancel ${identifier}: Title`)],
      {},
      {},
      { isError: true },
    ),
  },
  {
    name: 'a choice question',
    branch: answeredBranch([cancelOption(`Cancel ${identifier}: Title`)], {}, { kind: 'choice' }),
  },
];

it.each(nonApprovalBranches('ME-1'))('asks for $name', async ({ branch }) => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Unused work', identifier: 'ME-1' });
  const prompts: string[] = [];

  const context = branchContext(branch, async (title) => {
    prompts.push(title);

    return false;
  });

  expect(await cancel(fake.exec, context, issue.identifier)).toEqual({
    status: 'declined',
    identifier: issue.identifier,
  });

  expect(prompts).toHaveLength(1);
  expect(fake.writes()).toEqual([]);
  expect(issue.state.type).toBe('started');
});

it('refuses a merged-PR ticket with an approving branch and no dialog', async () => {
  const fake = createLinearFake();

  const issue = fake.addIssue({
    title: 'Merged work',
    pullRequests: [pullRequest],
    identifier: 'ME-1',
  });

  fake.mergedPullRequests.add(pullRequest);
  const prompts: string[] = [];

  const context = branchContext(approvalBranch(issue.identifier), async (title) => {
    prompts.push(title);

    return true;
  });

  await expect(cancel(fake.exec, context, issue.identifier)).rejects.toThrow(pullRequest);

  expect(fake.writes()).toEqual([]);
  expect(issue.state.type).toBe('started');
  expect(prompts).toEqual([]);
});

it('declines a worker with an approving branch and no dialog', async () => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Unused work', identifier: 'ME-1' });
  const prompts: string[] = [];

  const context = branchContext(approvalBranch(issue.identifier), async (title) => {
    prompts.push(title);

    return true;
  });

  vi.stubEnv('TAU_ROLE', 'worker');

  expect(await cancel(fake.exec, context, issue.identifier)).toEqual({
    status: 'declined',
    identifier: issue.identifier,
  });

  expect(fake.writes()).toEqual([]);
  expect(prompts).toEqual([]);
});
