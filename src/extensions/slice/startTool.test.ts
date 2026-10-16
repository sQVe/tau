import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { createStartSliceTool } from './startTool.js';
import { createSliceTool } from './tool.js';

type Fake = ReturnType<typeof createLinearFake>;

interface Ticket {
  number: number;
  identifier: string | null;
  url: string | null;
  title: string;
  status: string;
}

interface Details {
  status: string;
  tickets: Ticket[];
  writes: { kind: string }[];
  problems: string[];
  stateToken: string;
}

const fixtures = join(import.meta.dirname, 'fixtures', 'starts');

const addSlice = (fake: Fake) => fake.addIssue({ identifier: 'ME-700', title: 'The slice' });

const addAgentChild = (
  fake: Fake,
  overrides: Partial<Parameters<Fake['addIssue']>[0]> & { title: string },
) =>
  fake.addIssue({
    parent: 'ME-700',
    teamId: 'team-ai',
    projectId: null,
    ...overrides,
  });

const setUp = async (fake = createLinearFake()) => {
  const root = await createTemporaryRepository(onTestFinished);
  const context = noUiContext(root);

  const prepare = await createSliceTool(fake.exec).execute(
    'call',
    { action: 'prepare', id: 'me-700' },
    undefined,
    undefined,
    context,
  );

  const { directory } = prepare.details as { directory: string };

  await copyFile(join(fixtures, 'version-1.json'), join(directory, 'start.json'));
  await writeFile(join(directory, 'agent-1.md'), 'One.\n');
  await writeFile(join(directory, 'agent-2.md'), 'Two.\n');

  const call = async (
    action: 'read' | 'apply',
    stateToken?: string,
    useFake: Fake = fake,
    useContext: ExtensionToolContext = context,
  ): Promise<Details> => {
    const result = await createStartSliceTool(useFake.exec).execute(
      'call',
      { action, directory, agentTeam: 'AI', ...(stateToken === undefined ? {} : { stateToken }) },
      undefined,
      undefined,
      useContext,
    );

    return result.details as unknown as Details;
  };

  const apply = async (useFake: Fake = fake, useContext: ExtensionToolContext = context) => {
    const { stateToken } = await call('read', undefined, useFake, useContext);

    return call('apply', stateToken, useFake, useContext);
  };

  const snapshot = async () => {
    const names = await readdir(directory);

    return Promise.all(
      names.toSorted().map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
    );
  };

  const saved = async () =>
    (
      JSON.parse(await readFile(join(directory, 'start.json'), 'utf8')) as {
        tickets: { identifier: string | null }[];
      }
    ).tickets.map((ticket) => ticket.identifier);

  const recordNoIdentifiers = async () => {
    const record = JSON.parse(await readFile(join(directory, 'start.json'), 'utf8')) as {
      tickets: { identifier: string | null }[];
    };

    for (const ticket of record.tickets) {
      ticket.identifier = null;
    }

    await writeFile(join(directory, 'start.json'), JSON.stringify(record));
  };

  return { root, context, directory, call, apply, saved, snapshot, recordNoIdentifiers };
};

const withoutEditedBody = (files: (string | undefined)[][]) =>
  files.filter(([name]) => name !== 'agent-2.md');

const children = (fake: Fake) =>
  [...fake.issues.values()].filter((issue) => issue.parent === 'ME-700');

describe('start_slice', () => {
  it('creates the missing tickets in the agent team with no project and records them', async () => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Two.\n' });

    const { apply, saved } = await setUp(fake);
    const result = await apply();
    const created = children(fake).find((issue) => issue.title === 'Record the start');

    expect(created).toMatchObject({
      teamId: 'team-ai',
      projectId: null,
      labelIds: ['label-feature'],
      description: 'One.\n',
    });

    expect(result.tickets.map((ticket) => ticket.status)).toEqual(['new', 'unchanged']);
    expect(await saved()).toEqual([created?.identifier, 'AI-12']);
    expect(result.tickets[0]?.url).toContain(created?.identifier);
  });

  it('reports applied on the first run and unchanged on a retry with nothing to write', async () => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Two.\n' });

    const { apply } = await setUp(fake);
    const first = await apply();
    const writesAfterFirst = fake.writes().length;
    const retry = await apply();

    expect(first.status).toBe('applied');
    expect(retry.status).toBe('unchanged');
    expect(fake.writes()).toHaveLength(writesAfterFirst);
  });

  it('refuses when the draft directory becomes a symlink while apply reads Linear', async () => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Two.\n' });

    const { directory, call } = await setUp(fake);
    const outside = await mkdtemp(join(tmpdir(), 'tau-start-outside-'));

    onTestFinished(() => rm(outside, { recursive: true, force: true }));

    const originalRecord = await readFile(join(directory, 'start.json'), 'utf8');
    const { stateToken } = await call('read');

    const racing: Fake = {
      ...fake,
      exec: async (command, commandArguments, options) => {
        const result = await fake.exec(command, commandArguments, options);

        const isChildrenRead = commandArguments.some((argument) =>
          argument.includes('children(first'),
        );

        if (isChildrenRead) {
          await rm(outside, { recursive: true, force: true });
          await cp(directory, outside, { recursive: true });
          await rm(directory, { recursive: true });
          await symlink(outside, directory);
        }

        return result;
      },
    };

    await expect(call('apply', stateToken, racing)).rejects.toThrow(/symlink/u);

    expect(fake.writes()).toEqual([]);
    expect(await readFile(join(outside, 'start.json'), 'utf8')).toBe(originalRecord);
  });

  it('reports the planned writes on read and writes nothing', async () => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Old.\n' });

    const { call, saved } = await setUp(fake);
    const before = await saved();
    const result = await call('read');

    expect(result.writes.map((write) => write.kind)).toEqual(['createTicket', 'updateBody']);
    expect(result.problems).toEqual([]);
    expect(fake.writes()).toEqual([]);
    expect(await saved()).toEqual(before);
  });

  it('updates a recorded ticket whose body differs and leaves a matching one alone', async () => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Old.\n' });
    addAgentChild(fake, { identifier: 'AI-13', title: 'Record the start', description: 'One.\n' });

    const { directory, apply } = await setUp(fake);

    const record = JSON.parse(await readFile(join(directory, 'start.json'), 'utf8')) as {
      tickets: { identifier: string | null }[];
    };

    record.tickets[0]!.identifier = 'AI-13';
    await writeFile(join(directory, 'start.json'), JSON.stringify(record));

    const result = await apply();

    expect(result.tickets.map((ticket) => ticket.status)).toEqual(['unchanged', 'updated']);
    expect(fake.issues.get('AI-12')?.description).toBe('Two.\n');
    expect(fake.writes()).toHaveLength(1);
  });

  it('records a same-title child that fits instead of creating a second ticket', async () => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-20', title: 'Record the start', description: 'Old.\n' });
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Two.\n' });

    const { apply, saved } = await setUp(fake);
    const result = await apply();

    expect(children(fake)).toHaveLength(2);
    expect(await saved()).toEqual(['AI-20', 'AI-12']);
    expect(fake.issues.get('AI-20')?.description).toBe('One.\n');
    expect(result.tickets.map((ticket) => ticket.status)).toEqual(['updated', 'unchanged']);
  });

  it.each([
    { case: 'in another team', overrides: { teamId: 'team-me', projectId: null } },
    { case: 'in a project', overrides: { teamId: 'team-ai', projectId: 'project-tau' } },
  ])('refuses a same-title child $case and writes nothing', async ({ overrides }) => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'ME-30', title: 'Record the start', ...overrides });
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Old.\n' });

    const { call, saved } = await setUp(fake);
    const before = await saved();
    const read = await call('read');

    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]).toContain('ME-30');

    await expect(call('apply', read.stateToken)).rejects.toThrow(
      'Apply refuses while read reports problems. Nothing was written',
    );

    expect(fake.writes()).toEqual([]);
    expect(await saved()).toEqual(before);
  });

  it('lists a created ticket as applied when saving its identifier fails', async () => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Two.\n' });

    const { directory, call } = await setUp(fake);
    const { stateToken } = await call('read');
    const recordFile = join(directory, 'start.json');

    const failingSave: Fake = {
      ...fake,
      exec: async (command, commandArguments, options) => {
        const result = await fake.exec(command, commandArguments, options);

        if (commandArguments.some((argument) => argument.includes('issueCreate'))) {
          await rm(recordFile);
          await mkdir(recordFile);
        }

        return result;
      },
    };

    const failure = await call('apply', stateToken, failingSave).catch(
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);

    const [, applied = '', notApplied = ''] = (failure as Error).message.split(
      /\nApplied:\n|\nNot applied:\n/u,
    );

    expect(applied).toContain('Create ticket 1');
    expect(notApplied).not.toContain('Create ticket 1');
    expect(notApplied).toContain('Save the identifier of ticket 1');
    expect(children(fake)).toHaveLength(2);
  });

  it('keeps the first identifier after a failed second create, and the retry creates only the second', async () => {
    const fake = createLinearFake();

    addSlice(fake);

    const { apply, saved, recordNoIdentifiers } = await setUp(fake);

    await recordNoIdentifiers();
    fake.failWrite(2);

    await expect(apply()).rejects.toThrow('Creating ticket 2 "Report the start" failed');

    const [first, second] = await saved();

    expect(first).toMatch(/^ME-\d+$/u);
    expect(second).toBeNull();
    expect(children(fake)).toHaveLength(1);

    const result = await apply();

    expect(children(fake)).toHaveLength(2);
    expect(result.tickets.map((ticket) => ticket.status)).toEqual(['unchanged', 'new']);
    expect(result.tickets[0]?.identifier).toBe(first);
  });

  it('stops at a create that prints no identifier and tells the model to read again', async () => {
    const fake = createLinearFake();

    addSlice(fake);

    const { apply, saved, recordNoIdentifiers } = await setUp(fake);

    await recordNoIdentifiers();
    fake.overrideOutput('issueCreate', '{"data":{"issueCreate":{"issue":null}}}');

    await expect(apply()).rejects.toThrow('Call read again before any retry');

    expect(await saved()).toEqual([null, null]);
    expect(fake.writes()).toHaveLength(1);
  });

  it('records a child that an earlier create made but never reported', async () => {
    const lost = createLinearFake();

    addSlice(lost);

    const { apply, saved, recordNoIdentifiers } = await setUp(lost);

    await recordNoIdentifiers();
    lost.overrideOutput('issueCreate', '{"data":{"issueCreate":{"issue":null}}}');
    await expect(apply()).rejects.toThrow('read again');

    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-40', title: 'Record the start', description: 'One.\n' });

    const result = await apply(fake);

    expect((await saved())[0]).toBe('AI-40');
    expect(result.tickets[0]?.status).toBe('unchanged');
    expect(children(fake).filter((issue) => issue.title === 'Record the start')).toHaveLength(1);
  });

  it('refuses a stateToken from before the body file changed', async () => {
    const fake = createLinearFake();

    addSlice(fake);

    const { directory, call, saved } = await setUp(fake);
    const before = await saved();
    const { stateToken } = await call('read');

    await writeFile(join(directory, 'agent-1.md'), 'Changed.\n');

    await expect(call('apply', stateToken)).rejects.toThrow('changed since the read');

    expect(fake.writes()).toEqual([]);
    expect(await saved()).toEqual(before);
  });

  it('refuses a stateToken from before a child appeared in Linear', async () => {
    const fake = createLinearFake();

    addSlice(fake);

    const { call } = await setUp(fake);
    const { stateToken } = await call('read');

    addAgentChild(fake, { identifier: 'AI-50', title: 'Record the start' });

    await expect(call('apply', stateToken)).rejects.toThrow('changed since the read');

    expect(fake.writes()).toEqual([]);
  });

  it('reports a missing start.json as a problem on read and refuses apply', async () => {
    const fake = createLinearFake();

    addSlice(fake);

    const { directory, call } = await setUp(fake);

    await rm(join(directory, 'start.json'));

    const read = await call('read');

    expect(read.problems).toHaveLength(1);
    await expect(call('apply', read.stateToken)).rejects.toThrow('has no start.json');
    expect(fake.writes()).toEqual([]);
  });

  it('leaves every draft file unchanged on a normal read', async () => {
    const fake = createLinearFake();

    addSlice(fake);

    const { call, snapshot } = await setUp(fake);
    const before = await snapshot();

    await call('read');

    expect(await snapshot()).toEqual(before);
    expect(fake.writes()).toEqual([]);
  });

  it('leaves every draft file unchanged when a read finds no start.json', async () => {
    const fake = createLinearFake();

    addSlice(fake);

    const { directory, call, snapshot } = await setUp(fake);

    await rm(join(directory, 'start.json'));

    const before = await snapshot();

    await call('read');

    expect(await snapshot()).toEqual(before);
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    { case: 'not JSON', content: 'not json', message: 'not JSON' },
    {
      case: 'against the schema',
      content: JSON.stringify({ version: 1, slice: 'ME-700' }),
      message: 'Malformed start record',
    },
    { case: 'newer', content: '{"version":2}', message: 'newer format' },
  ])('refuses a read of a start.json that is $case and leaves the draft unchanged', async (bad) => {
    const fake = createLinearFake();

    addSlice(fake);

    const { directory, call, apply, snapshot } = await setUp(fake);

    await writeFile(join(directory, 'start.json'), bad.content);

    const before = await snapshot();

    await expect(call('read')).rejects.toThrow(bad.message);
    await expect(apply()).rejects.toThrow(bad.message);

    expect(await snapshot()).toEqual(before);
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    {
      case: 'is not JSON',
      arrange: (fake: Fake) => {
        fake.overrideOutput('children(first', 'oops');
      },
      message: 'not JSON',
    },
    {
      case: 'has the wrong shape',
      arrange: (fake: Fake) => {
        fake.overrideOutput('children(first', '{"data":{"issue":{"id":1}}}');
      },
      message: 'printed unexpected output',
    },
    {
      case: 'is a failed call',
      arrange: (fake: Fake) => {
        fake.failCall('children(first', 'network error');
      },
      message: 'network error',
    },
    {
      case: 'finds no slice',
      arrange: (fake: Fake) => {
        fake.issues.delete('ME-700');
      },
      message: 'Linear has no issue ME-700',
    },
  ])('refuses a read when the Linear output $case and leaves the draft unchanged', async (bad) => {
    const fake = createLinearFake();

    addSlice(fake);

    const { call, snapshot } = await setUp(fake);
    const before = await snapshot();

    bad.arrange(fake);

    await expect(call('read')).rejects.toThrow(bad.message);

    expect(await snapshot()).toEqual(before);
    expect(fake.writes()).toEqual([]);
  });

  it('refuses a truncated child list, so a child on a later page is not created twice', async () => {
    const fake = createLinearFake();

    addSlice(fake);
    addAgentChild(fake, { identifier: 'AI-12', title: 'Report the start', description: 'Two.\n' });
    addAgentChild(fake, { identifier: 'AI-13', title: 'Record the start', description: 'One.\n' });
    fake.limitChildren(1);

    const { call, apply, snapshot } = await setUp(fake);
    const before = await snapshot();

    await expect(call('read')).rejects.toThrow('more children than one Linear page');
    await expect(apply()).rejects.toThrow('more children than one Linear page');

    expect(fake.writes()).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(children(fake)).toHaveLength(2);
  });
});

const prompts = (root: string, answer: boolean) => {
  const seen: string[] = [];

  const context = confirmContext(root, async (title, message) => {
    seen.push(`${title}\n${message}`);

    return answer;
  });

  return { seen, context };
};

describe('start_slice ownership', () => {
  const setUpForeign = async (
    overrides: Parameters<Fake['addIssue']>[0] extends infer T ? Partial<T> : never,
  ) => {
    const fake = createLinearFake();

    addSlice(fake);

    addAgentChild(fake, {
      identifier: 'AI-12',
      title: 'Report the start',
      description: 'Old.\n',
      ...overrides,
    });

    const setUpResult = await setUp(fake);

    return { fake, ...setUpResult };
  };

  it('updates a ticket another person created after the user confirms the exact writes', async () => {
    const { fake, root, apply } = await setUpForeign({ creatorId: 'user-other' });
    const { seen, context } = prompts(root, true);
    const result = await apply(fake, context);

    expect(result.tickets.map((ticket) => ticket.status)).toEqual(['new', 'updated']);
    expect(fake.issues.get('AI-12')?.description).toBe('Two.\n');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('AI-12');
    expect(seen[0]).toContain('Create ticket 1');
  });

  it('confirms a ticket whose owner is unknown', async () => {
    const { fake, root, apply } = await setUpForeign({ creatorId: null });
    const { seen, context } = prompts(root, true);

    await apply(fake, context);

    expect(seen).toHaveLength(1);
    expect(fake.issues.get('AI-12')?.description).toBe('Two.\n');
  });

  it('confirms a ticket assigned to another person even when the viewer created it', async () => {
    const { fake, root, apply } = await setUpForeign({ assigneeId: 'user-other' });
    const { seen, context } = prompts(root, true);

    await apply(fake, context);

    expect(seen).toHaveLength(1);
  });

  it('asks nothing for a ticket the viewer owns', async () => {
    const { fake, root, apply } = await setUpForeign({
      assigneeId: 'user-viewer',
      creatorId: 'user-other',
    });

    const { seen, context } = prompts(root, true);

    await apply(fake, context);

    expect(seen).toEqual([]);
    expect(fake.issues.get('AI-12')?.description).toBe('Two.\n');
  });

  it('writes nothing to Linear or start.json when the user declines', async () => {
    const { fake, root, apply, snapshot } = await setUpForeign({ creatorId: 'user-other' });
    const before = await snapshot();
    const { context } = prompts(root, false);
    const result = await apply(fake, context);

    expect(result.status).toBe('declined');
    expect(fake.writes()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses without a UI and leaves Linear and start.json unchanged', async () => {
    const { fake, apply, snapshot } = await setUpForeign({ creatorId: 'user-other' });
    const before = await snapshot();

    await expect(apply()).rejects.toThrow(/session without UI cannot give.*Nothing was written/u);

    expect(fake.writes()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses in a worker with a UI, asks nothing, and leaves Linear and start.json unchanged', async () => {
    vi.stubEnv('TAU_WORKER_RECORD', '/records/task-one');

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const { fake, root, apply, snapshot } = await setUpForeign({ creatorId: 'user-other' });
    const before = await snapshot();
    const { seen, context } = prompts(root, true);

    await expect(apply(fake, context)).rejects.toThrow(/worker cannot give.*Nothing was written/u);

    expect(seen).toEqual([]);
    expect(fake.writes()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('shows the current and new body of each foreign ticket in the confirm', async () => {
    const { fake, root, apply } = await setUpForeign({ creatorId: 'user-other' });
    const { seen, context } = prompts(root, true);

    await apply(fake, context);

    expect(seen[0]).toContain('now holds:\n---\nOld.\n');
    expect(seen[0]).toContain('will hold:\n---\nTwo.\n');
  });

  it('writes nothing when a body file changes during the recheck after the answer', async () => {
    const { fake, root, directory, apply, snapshot } = await setUpForeign({
      creatorId: 'user-other',
    });

    let answered = false;
    let afterAnswer = 0;

    const context = confirmContext(root, async () => {
      answered = true;

      return true;
    });

    const racing: Fake = {
      ...fake,
      exec: async (command, commandArguments, options) => {
        const isChildrenRead = commandArguments.some((argument) =>
          argument.includes('children(first'),
        );

        if (answered && isChildrenRead) {
          afterAnswer += 1;
          const result = await fake.exec(command, commandArguments, options);

          await writeFile(join(directory, 'agent-2.md'), 'Edited during the recheck.\n');

          return result;
        }

        return fake.exec(command, commandArguments, options);
      },
    };

    const before = await snapshot();

    await expect(apply(racing, context)).rejects.toThrow('changed');

    expect(afterAnswer).toBe(1);
    expect(fake.writes()).toEqual([]);

    const after = await snapshot();
    expect(withoutEditedBody(after)).toEqual(withoutEditedBody(before));
  });

  it('writes nothing when Linear changes while the user answers', async () => {
    const { fake, root, apply, snapshot } = await setUpForeign({ creatorId: 'user-other' });
    const before = await snapshot();

    const context = confirmContext(root, async () => {
      addAgentChild(fake, { identifier: 'AI-60', title: 'Other' });

      return true;
    });

    await expect(apply(fake, context)).rejects.toThrow('changed while you answered');

    expect(fake.writes()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});
