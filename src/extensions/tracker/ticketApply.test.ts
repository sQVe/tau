import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { runGit } from '../../git.js';
import { prepare } from './prepare.js';
import * as ticketApply from './ticketApply.js';

afterEach(() => vi.unstubAllEnvs());

const setup = async () => {
  const cwd = await createTemporaryRepository(onTestFinished);
  await runGit(cwd, ['remote', 'add', 'origin', 'https://github.com/sQVe/tau.git']);
  const fake = createLinearFake();
  const context = noUiContext(cwd);
  const location = { cwd, agentDirectory: cwd, projectTrusted: false };

  await writeFile(
    join(cwd, 'tau.json'),
    JSON.stringify({
      tracker: { repositories: { 'sQVe/tau': { team: 'ME', project: 'Tau' } } },
    }),
  );

  const { directory } = await prepare(cwd, 'example');
  await writeFile(join(directory, 'title.md'), 'Fix the failure\n');
  await writeFile(join(directory, 'ticket.md'), 'Reproduction details.\n');

  return { runtime: { exec: fake.exec, context, location }, fake, directory };
};

const setupUpdate = async () => {
  const state = await setup();

  const ticket = state.fake.addIssue({
    title: 'Old title',
    description: 'Reproduction details.\n',
  });

  const record = JSON.stringify({
    version: 3,
    identifier: ticket.identifier,
    comments: { '# Existing': 'comment-1' },
  });

  await writeFile(join(state.directory, 'draft.json'), record);

  return { ...state, ticket, record };
};

it('binds a prepared draft to an existing ticket without creating a duplicate', async () => {
  const { runtime, fake } = await setup();

  const existing = fake.addIssue({
    identifier: 'ME-42',
    title: 'Old title',
    description: 'Original body',
  });

  const prepared = await prepare(runtime.context.cwd, 'me-42');
  expect(prepared.draft).toBeNull();
  await writeFile(join(prepared.directory, 'title.md'), 'Retitled ticket\n');
  await writeFile(join(prepared.directory, 'ticket.md'), 'Updated body');
  const request = { directory: prepared.directory, ticket: existing.identifier };
  const plan = await ticketApply.readTicket(runtime, request);

  expect(plan.identifier).toBe(existing.identifier);
  expect(plan.current).toMatchObject({ title: 'Old title', description: 'Original body' });
  expect(plan.writes).toMatchObject([{ kind: 'updateTicket' }]);

  await expect(readFile(join(prepared.directory, 'draft.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });

  const result = await ticketApply.applyTicket(runtime, {
    ...request,
    stateToken: plan.stateToken,
  });

  expect(result).toMatchObject({ status: 'updated', identifier: existing.identifier });
  expect(existing).toMatchObject({ title: 'Retitled ticket', description: 'Updated body' });
  expect(fake.issues.size).toBe(1);
  expect(fake.writes()).toHaveLength(1);

  expect(JSON.parse(await readFile(join(prepared.directory, 'draft.json'), 'utf8'))).toEqual({
    version: 3,
    identifier: existing.identifier,
    comments: {},
  });
});

it('refuses a requested ticket that differs from the recorded identifier', async () => {
  const { runtime, fake, directory, ticket, record } = await setupUpdate();
  const request = { directory, ticket: 'ME-999' };
  fake.failCall('issue(id:', 'Ticket lookup unavailable');
  const before = structuredClone([...fake.issues]);
  const plan = await ticketApply.readTicket(runtime, request);

  expect(plan.problems.join('\n')).toContain(ticket.identifier);
  expect(plan.problems.join('\n')).toContain(request.ticket);
  expect(plan.writes).toEqual([]);

  await expect(
    ticketApply.applyTicket(runtime, { ...request, stateToken: plan.stateToken }),
  ).rejects.toThrow('ME-999');

  expect(fake.writes()).toEqual([]);
  expect([...fake.issues]).toEqual(before);
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(record);
});

it('requires an explicitly requested ticket to exist', async () => {
  const { runtime, fake, directory } = await setup();
  const request = { directory, ticket: 'ME-404' };

  await expect(ticketApply.readTicket(runtime, request)).rejects.toThrow('ME-404');

  await expect(
    ticketApply.applyTicket(runtime, { ...request, stateToken: 'unused' }),
  ).rejects.toThrow('ME-404');

  expect(fake.writes()).toEqual([]);
  expect(fake.issues.size).toBe(0);
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects malformed evidence for an explicitly requested ticket', async () => {
  const { runtime, fake, directory } = await setup();
  const existing = fake.addIssue({ title: 'Old title' });
  const request = { directory, ticket: existing.identifier };
  fake.overrideOutput('issue(id:', '{"data":{}}');

  await expect(ticketApply.readTicket(runtime, request)).rejects.toThrow('unexpected output');

  await expect(
    ticketApply.applyTicket(runtime, { ...request, stateToken: 'unused' }),
  ).rejects.toThrow('unexpected output');

  expect(fake.writes()).toEqual([]);
  expect(existing.title).toBe('Old title');
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('records an unchanged existing ticket without a Linear write', async () => {
  const { runtime, fake, directory } = await setup();

  const existing = fake.addIssue({
    title: 'Fix the failure',
    description: 'Reproduction details.\n',
  });

  const request = { directory, ticket: existing.identifier };
  const plan = await ticketApply.readTicket(runtime, request);

  const result = await ticketApply.applyTicket(runtime, {
    ...request,
    stateToken: plan.stateToken,
  });

  expect(result).toMatchObject({ status: 'unchanged', identifier: existing.identifier });
  expect(fake.writes()).toEqual([]);

  expect(JSON.parse(await readFile(join(directory, 'draft.json'), 'utf8'))).toEqual({
    version: 3,
    identifier: existing.identifier,
    comments: {},
  });
});

it('preserves comment identifiers when binding an unrecorded draft', async () => {
  const { runtime, fake, directory } = await setup();
  const existing = fake.addIssue({ title: 'Old title' });
  const comments = { '# Existing': 'comment-1' };

  await writeFile(
    join(directory, 'draft.json'),
    JSON.stringify({ version: 3, identifier: null, comments }),
  );

  const request = { directory, ticket: existing.identifier };
  const plan = await ticketApply.readTicket(runtime, request);

  await ticketApply.applyTicket(runtime, { ...request, stateToken: plan.stateToken });

  expect(JSON.parse(await readFile(join(directory, 'draft.json'), 'utf8'))).toEqual({
    version: 3,
    identifier: existing.identifier,
    comments,
  });

  expect(existing.title).toBe('Fix the failure');
});

it('includes the explicit ticket argument in the state token', async () => {
  const { runtime, fake, directory, ticket, record } = await setupUpdate();
  const plan = await ticketApply.readTicket(runtime, { directory, ticket: ticket.identifier });

  await expect(
    ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken }),
  ).rejects.toThrow('changed');

  expect(fake.writes()).toEqual([]);
  expect(ticket.title).toBe('Old title');
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(record);
});

it('does not bind a declined first update', async () => {
  const { runtime, fake, directory } = await setup();
  const existing = fake.addIssue({ title: 'Old title', assigneeId: 'someone-else' });
  const request = { directory, ticket: existing.identifier };
  const plan = await ticketApply.readTicket(runtime, request);

  const result = await ticketApply.applyTicket(runtime, {
    ...request,
    stateToken: plan.stateToken,
  });

  expect(result).toMatchObject({ status: 'declined', identifier: existing.identifier });
  expect(fake.writes()).toEqual([]);
  expect(existing.title).toBe('Old title');
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('makes no Linear update when saving the existing identifier fails', async () => {
  const { runtime, fake, directory } = await setup();
  const existing = fake.addIssue({ title: 'Old title' });
  const request = { directory, ticket: existing.identifier };
  const plan = await ticketApply.readTicket(runtime, request);

  runtime.exec = async (command, commandArguments, options) => {
    const result = await fake.exec(command, commandArguments, options);

    if (commandArguments[1]?.includes('issue(id:') === true) {
      await mkdir(join(directory, 'draft.json'));
    }

    return result;
  };

  await expect(
    ticketApply.applyTicket(runtime, { ...request, stateToken: plan.stateToken }),
  ).rejects.toThrow(/Could not record ME-1.*No Linear update was made/u);

  expect(fake.writes()).toEqual([]);
  expect(existing.title).toBe('Old title');
  expect(fake.issues.size).toBe(1);
});

it('keeps the binding when the first Linear update fails', async () => {
  const { runtime, fake, directory } = await setup();
  const existing = fake.addIssue({ title: 'Old title' });
  const request = { directory, ticket: existing.identifier };
  const plan = await ticketApply.readTicket(runtime, request);
  fake.failCall('issueUpdate', 'Update unavailable');

  await expect(
    ticketApply.applyTicket(runtime, { ...request, stateToken: plan.stateToken }),
  ).rejects.toThrow('Update unavailable');

  expect(existing.title).toBe('Old title');
  expect(fake.issues.size).toBe(1);

  expect(JSON.parse(await readFile(join(directory, 'draft.json'), 'utf8'))).toMatchObject({
    identifier: existing.identifier,
  });

  const retry = await ticketApply.readTicket(runtime, { directory });

  expect(retry.identifier).toBe(existing.identifier);
  expect(retry.writes).toMatchObject([{ kind: 'updateTicket' }]);
});

it('reports the created ticket when saving its identifier fails and blocks a duplicate retry', async () => {
  const { runtime, fake, directory } = await setup();
  const recordPath = join(directory, 'draft.json');
  const plan = await ticketApply.readTicket(runtime, { directory });

  runtime.exec = async (command, commandArguments, options) => {
    const result = await fake.exec(command, commandArguments, options);

    if (commandArguments[1]?.includes('issueCreate') === true) {
      await mkdir(recordPath);
    }

    return result;
  };

  await expect(
    ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken }),
  ).rejects.toThrow(/ME-1[\s\S]*https:\/\/linear\.app\/me\/issue\/ME-1/u);

  expect(fake.writes()).toHaveLength(1);
  expect(fake.issues.get('ME-1')).toMatchObject({ title: 'Fix the failure' });

  await rm(recordPath, { recursive: true });
  const retry = await ticketApply.readTicket(runtime, { directory });

  expect(retry.problems.join('\n')).toContain('ME-1');
  expect(retry.writes).toEqual([]);

  await expect(
    ticketApply.applyTicket(runtime, { directory, stateToken: retry.stateToken }),
  ).rejects.toThrow('ME-1');

  expect(fake.writes()).toHaveLength(1);
  expect(fake.issues.size).toBe(1);
  await expect(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an unrecorded draft matching an open ticket the viewer created in the route', async () => {
  const { runtime, fake, directory } = await setup();
  const existing = fake.addIssue({ title: 'Fix the failure', assigneeId: 'someone-else' });
  const before = structuredClone([...fake.issues]);
  const plan = await ticketApply.readTicket(runtime, { directory });

  expect(plan.problems.join('\n')).toContain(existing.identifier);
  expect(plan.writes).toEqual([]);

  await expect(
    ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken }),
  ).rejects.toThrow(existing.identifier);

  expect(fake.writes()).toEqual([]);
  expect([...fake.issues]).toEqual(before);
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  { name: 'another creator', issue: { creatorId: 'someone-else', assigneeId: 'user-viewer' } },
  { name: 'another title', issue: { title: 'Fix the failure elsewhere' } },
  { name: 'another team', issue: { teamId: 'team-ai' } },
  { name: 'another project', issue: { projectId: null } },
  { name: 'a closed ticket', issue: { state: { type: 'completed' as const, name: 'Done' } } },
])('allows an unrecorded draft beside $name', async ({ issue }) => {
  const { runtime, fake, directory } = await setup();
  fake.addIssue({ title: 'Fix the failure', ...issue });
  const plan = await ticketApply.readTicket(runtime, { directory });

  expect(plan.problems).toEqual([]);
  expect(plan.writes).toMatchObject([{ kind: 'createTicket' }]);
  expect(fake.writes()).toEqual([]);
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports a missing route for an unrecorded draft without writing', async () => {
  const { runtime, fake, directory } = await setup();
  await rm(join(runtime.location.agentDirectory, 'tau.json'));
  const plan = await ticketApply.readTicket(runtime, { directory });

  expect(plan.problems.join('\n')).toContain('Tracker setup needed:');
  expect(plan.writes).toEqual([]);

  await expect(
    ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken }),
  ).rejects.toThrow('Tracker setup needed:');

  expect(fake.writes()).toEqual([]);
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a create when a matching ticket appears after read', async () => {
  const { runtime, fake, directory } = await setup();
  const plan = await ticketApply.readTicket(runtime, { directory });
  fake.addIssue({ title: 'Fix the failure' });

  await expect(
    ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken }),
  ).rejects.toThrow('changed');

  expect(fake.writes()).toEqual([]);
  expect(fake.issues.size).toBe(1);
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  {
    name: 'partial search',
    output: '{"data":{"searchIssues":{"nodes":[],"pageInfo":{"hasNextPage":true}}}}',
    error: /another page/u,
  },
  { name: 'malformed search', output: '{"data":{}}', error: /unexpected output/u },
])('refuses $name evidence without writing', async ({ output, error }) => {
  const { runtime, fake, directory } = await setup();
  fake.overrideOutput('searchIssues', output);

  await expect(ticketApply.readTicket(runtime, { directory })).rejects.toThrow(error);
  expect(fake.writes()).toEqual([]);
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('updates only the changed field', async () => {
  const { runtime, fake, directory, ticket, record } = await setupUpdate();
  fake.failCall('searchIssues', 'Search unavailable');
  const plan = await ticketApply.readTicket(runtime, { directory });
  expect(plan.current).toMatchObject({ title: ticket.title, description: ticket.description });
  const result = await ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken });

  expect(result).toMatchObject({ status: 'updated', identifier: ticket.identifier });
  expect(ticket.title).toBe('Fix the failure');
  expect(ticket.description).toBe('Reproduction details.\n');
  expect(fake.writes()).toHaveLength(1);
  const commandArguments = fake.writes()[0]!.commandArguments;

  const variables: unknown = JSON.parse(
    commandArguments[commandArguments.indexOf('--variables-json') + 1]!,
  );

  expect(variables).toEqual({ id: ticket.identifier, input: { title: 'Fix the failure' } });
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(record);
});

it('leaves an unchanged ticket and draft alone', async () => {
  const { runtime, fake, directory, ticket, record } = await setupUpdate();
  ticket.title = 'Fix the failure';
  const plan = await ticketApply.readTicket(runtime, { directory });
  const result = await ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken });

  expect(result).toMatchObject({ status: 'unchanged', identifier: ticket.identifier });
  expect(fake.writes()).toEqual([]);
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(record);
});

it('refuses a changed state token without writes', async () => {
  const { runtime, fake, directory, record } = await setupUpdate();
  const plan = await ticketApply.readTicket(runtime, { directory });
  await writeFile(join(directory, 'title.md'), 'Changed after read');

  await expect(
    ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken }),
  ).rejects.toThrow('changed');

  expect(fake.writes()).toEqual([]);
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(record);
});

it('declines an update to another person without UI', async () => {
  const { runtime, fake, directory, ticket, record } = await setupUpdate();
  ticket.assigneeId = 'someone-else';
  const plan = await ticketApply.readTicket(runtime, { directory });
  const result = await ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken });

  expect(result).toMatchObject({ status: 'declined', identifier: ticket.identifier });
  expect(ticket.title).toBe('Old title');
  expect(fake.writes()).toEqual([]);
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(record);
});

it('refuses a ticket changed during confirmation', async () => {
  const state = await setupUpdate();
  state.ticket.assigneeId = 'someone-else';

  state.runtime.context = confirmContext(state.runtime.context.cwd, async () => {
    state.ticket.description = 'Concurrent edit';

    return true;
  });

  const plan = await ticketApply.readTicket(state.runtime, { directory: state.directory });

  await expect(
    ticketApply.applyTicket(state.runtime, {
      directory: state.directory,
      stateToken: plan.stateToken,
    }),
  ).rejects.toThrow('changed');

  expect(state.fake.writes()).toEqual([]);
  expect(await readFile(join(state.directory, 'draft.json'), 'utf8')).toBe(state.record);
});

it('resolves a parent identifier and sends label IDs when creating', async () => {
  const { runtime, fake, directory } = await setup();
  const parent = fake.addIssue({ identifier: 'ME-12', title: 'Parent', projectId: null });
  const request = { directory, parent: parent.identifier, labels: ['label-bug'] };
  const plan = await ticketApply.readTicket(runtime, request);

  const result = await ticketApply.applyTicket(runtime, {
    ...request,
    stateToken: plan.stateToken,
  });

  expect(fake.issues.get(result.identifier!)).toMatchObject({
    parent: 'ME-12',
    labelIds: ['label-bug'],
    projectId: 'project-tau',
  });
});

it.each([
  'normal',
  'missing title',
  'missing body',
  'malformed record',
  'missing ticket',
  'malformed Linear response',
])('reads %s evidence without changing saved files', async (mode) => {
  const state = await setupUpdate();

  if (mode === 'missing title') {
    await rm(join(state.directory, 'title.md'));
  }

  if (mode === 'missing body') {
    await rm(join(state.directory, 'ticket.md'));
  }

  if (mode === 'malformed record') {
    await writeFile(join(state.directory, 'draft.json'), '{');
  }

  if (mode === 'missing ticket') {
    state.fake.issues.clear();
  }

  if (mode === 'malformed Linear response') {
    state.fake.overrideOutput('description', '{"data":{}}');
  }

  const files = await readdir(state.directory);

  const before = await Promise.all(
    files.map((file) => readFile(join(state.directory, file), 'utf8')),
  );

  const issues = structuredClone([...state.fake.issues]);

  const outcome = await ticketApply.readTicket(state.runtime, { directory: state.directory }).then(
    (result) => ({ identifier: result.identifier, error: '' }),
    (error: unknown) => ({
      identifier: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  const expectedIdentifier = mode === 'normal' ? state.ticket.identifier : null;
  const expectedError = mode === 'normal' ? /^$/u : /ENOENT|not JSON|no issue|unexpected output/u;

  expect(outcome.identifier).toBe(expectedIdentifier);
  expect(outcome.error).toMatch(expectedError);

  expect(await readdir(state.directory)).toEqual(files);

  expect(
    await Promise.all(files.map((file) => readFile(join(state.directory, file), 'utf8'))),
  ).toEqual(before);

  expect([...state.fake.issues]).toEqual(issues);
  expect(state.fake.writes()).toEqual([]);
});

it.each(['declined', 'worker', 'approved'])('handles foreign update approval: %s', async (mode) => {
  const state = await setupUpdate();
  state.ticket.assigneeId = 'someone-else';
  const prompts: string[] = [];

  state.runtime.context = confirmContext(state.runtime.context.cwd, async (_title, message) => {
    prompts.push(message);

    return mode !== 'declined';
  });

  if (mode === 'worker') {
    vi.stubEnv('TAU_ROLE', 'worker');
  }

  const plan = await ticketApply.readTicket(state.runtime, { directory: state.directory });

  const result = await ticketApply.applyTicket(state.runtime, {
    directory: state.directory,
    stateToken: plan.stateToken,
  });

  expect(result.status).toBe(mode === 'approved' ? 'updated' : 'declined');
  expect(state.fake.writes()).toHaveLength(mode === 'approved' ? 1 : 0);
  expect(prompts).toHaveLength(mode === 'worker' ? 0 : 1);

  const expectedPrompt: unknown = expect.stringMatching(
    /Old title[\s\S]*Reproduction details\.[\s\S]*Fix the failure[\s\S]*Reproduction details\./u,
  );

  const expectedPrompts = mode === 'worker' ? [] : [expectedPrompt];

  expect(prompts).toEqual(expectedPrompts);

  expect(await readFile(join(state.directory, 'draft.json'), 'utf8')).toBe(state.record);
});

it.each(['title', 'description', 'owner', 'record', 'route', 'arguments'])(
  'refuses changed %s after read',
  async (change) => {
    const state = await setupUpdate();
    const request: { directory: string; parent?: string } = { directory: state.directory };
    const plan = await ticketApply.readTicket(state.runtime, request);

    if (change === 'title') {
      state.ticket.title = 'Concurrent title';
    }

    if (change === 'description') {
      state.ticket.description = 'Concurrent description';
    }

    if (change === 'owner') {
      state.ticket.assigneeId = 'other';
    }

    if (change === 'record') {
      await writeFile(join(state.directory, 'draft.json'), `${state.record}\n`);
    }

    if (change === 'route') {
      await writeFile(
        join(state.runtime.location.agentDirectory, 'tau.json'),
        JSON.stringify({ tracker: { repositories: { 'sQVe/tau': { team: 'AI' } } } }),
      );
    }

    if (change === 'arguments') {
      request.parent = 'ME-99';
    }

    const before = await readFile(join(state.directory, 'draft.json'), 'utf8');

    await expect(
      ticketApply.applyTicket(state.runtime, { ...request, stateToken: plan.stateToken }),
    ).rejects.toThrow('changed');

    expect(state.fake.writes()).toEqual([]);
    expect(await readFile(join(state.directory, 'draft.json'), 'utf8')).toBe(before);
  },
);

it.each(['missing route', 'parent on update', 'labels on update'])(
  'refuses apply with %s and writes nothing',
  async (problem) => {
    const state = await setupUpdate();

    const request: { directory: string; parent?: string; labels?: string[] } = {
      directory: state.directory,
    };

    if (problem === 'missing route') {
      await rm(join(state.runtime.location.agentDirectory, 'tau.json'));
    }

    if (problem === 'parent on update') {
      request.parent = 'ME-99';
    }

    if (problem === 'labels on update') {
      request.labels = [];
    }

    const plan = await ticketApply.readTicket(state.runtime, request);
    expect(plan.problems).not.toEqual([]);

    await expect(
      ticketApply.applyTicket(state.runtime, { ...request, stateToken: plan.stateToken }),
    ).rejects.toThrow(/Tracker setup needed|only accepted/);

    expect(state.fake.writes()).toEqual([]);
    expect(await readFile(join(state.directory, 'draft.json'), 'utf8')).toBe(state.record);
  },
);

it.each(['draft.json', 'title.md', 'ticket.md'])(
  'refuses linked %s before writing to Linear',
  async (file) => {
    const state = await setupUpdate();
    const target = join(state.runtime.context.cwd, 'saved.json');
    await writeFile(target, state.record);
    await rm(join(state.directory, file));
    await symlink(target, join(state.directory, file));

    await expect(
      ticketApply.readTicket(state.runtime, { directory: state.directory }),
    ).rejects.toThrow('symlink');

    expect(state.fake.writes()).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe(state.record);
  },
);

it('refuses changed create targets after read', async () => {
  const { runtime, fake, directory } = await setup();
  const plan = await ticketApply.readTicket(runtime, { directory });

  fake.overrideOutput(
    'projects(',
    JSON.stringify({
      data: {
        team: { id: 'replacement-team', projects: { nodes: [{ id: 'replacement-project' }] } },
      },
    }),
  );

  await expect(
    ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken }),
  ).rejects.toThrow('changed');

  expect(fake.writes()).toEqual([]);
  expect(fake.issues.size).toBe(0);
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('creates a routed ticket and records its identifier after read then apply', async () => {
  const { runtime, fake, directory } = await setup();
  const plan = await ticketApply.readTicket(runtime, { directory });

  expect(plan.problems).toEqual([]);
  expect(plan.writes).toMatchObject([{ kind: 'createTicket' }]);
  expect(fake.writes()).toEqual([]);
  await expect(readFile(join(directory, 'draft.json'))).rejects.toMatchObject({ code: 'ENOENT' });

  const result = await ticketApply.applyTicket(runtime, { directory, stateToken: plan.stateToken });

  expect(result).toMatchObject({ status: 'created', identifier: 'ME-1' });

  expect(fake.issues.get('ME-1')).toMatchObject({
    title: 'Fix the failure',
    description: 'Reproduction details.\n',
    teamId: 'team-me',
    projectId: 'project-tau',
  });

  expect(JSON.parse(await readFile(join(directory, 'draft.json'), 'utf8'))).toEqual({
    version: 3,
    identifier: 'ME-1',
    comments: {},
  });
});
