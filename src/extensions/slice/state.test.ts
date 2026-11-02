import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLinearFake } from '../../../tests/linearFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
import {
  appliedPlan,
  expectReadOnly,
  readDetails,
  run,
  setUp,
  temporaryRepository,
} from './fixtures/sliceToolHarness.js';
import { createSliceTool } from './tool.js';

describe('slice tool read', () => {
  it('reads the container, slices in order, merged state, dependencies, and the draft', async () => {
    const { fake, directory, read } = await appliedPlan();

    fake.issues.get('ME-2')!.pullRequests = ['https://github.com/sQVe/tau/pull/1'];
    fake.mergedPullRequests.add('https://github.com/sQVe/tau/pull/1');
    fake.addIssue({ identifier: 'ME-9', title: 'Dropped', parent: 'ME-1', sortOrder: 9 });

    const { value: result } = await expectReadOnly(fake, directory, read);

    expect(result).toMatchObject({
      draft: { container: { identifier: 'ME-1' } },
      container: {
        identifier: 'ME-1',
        children: [
          { identifier: 'ME-2', merged: true, blockedBy: [] },
          { identifier: 'ME-3', merged: false, blockedBy: ['ME-2'] },
          { identifier: 'ME-9' },
        ],
      },
      writes: [],
      problems: [],
      dropped: ['ME-9'],
    });
  });

  it('lists no write when Linear saved list items with other markers', async () => {
    const { fake, directory, apply, read } = await setUp();
    const body = '- one\n  - nested\n- two\n';

    await writeFile(join(directory, 'container.md'), body);
    await writeFile(join(directory, 'slice-1.md'), body);
    await writeFile(join(directory, 'slice-2.md'), body);
    await apply();

    expect(fake.issues.get('ME-2')!.description).toBe('* one\n  * nested\n* two\n');

    const result = await read();

    expect(result).toMatchObject({ writes: [], problems: [] });
  });

  it('reads a container before the draft has a plan', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = noUiContext(root);

    fake.addIssue({ identifier: 'ME-4', title: 'Existing' });
    const { directory } = await run(fake, context, { action: 'prepare', id: 'me-4' });

    await expect(
      run(fake, context, { action: 'read', directory, container: 'ME-4' }),
    ).resolves.toMatchObject({ draft: null, container: { identifier: 'ME-4', children: [] } });
  });

  it('reports a container that Linear does not have', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = noUiContext(root);
    const { directory } = await run(fake, context, { action: 'prepare', id: 'me-77' });

    const outcome = await expectReadOnly(fake, directory, () =>
      run(fake, context, { action: 'read', directory, container: 'ME-77' }),
    );

    expect(outcome.error).toMatch(/no issue ME-77/);
  });

  it('refuses a container for a draft that records none', async () => {
    const { fake, directory, read } = await setUp();

    fake.addIssue({ identifier: 'ME-4', title: 'Existing' });
    const outcome = await expectReadOnly(fake, directory, () => read('ME-4'));

    expect(outcome.error).toMatch(/records no container identifier.*ME-4/);
  });

  it('names a linear call that was killed', async () => {
    const { fake, context, directory } = await appliedPlan();

    const tool = createSliceTool(async (command, commandArguments, options) => ({
      ...(await fake.exec(command, commandArguments, options)),
      killed: true,
    }));

    const outcome = await expectReadOnly(fake, directory, () =>
      tool.execute('call', { action: 'read', directory }, undefined, undefined, context),
    );

    expect(outcome.error).toMatch(/^linear api .* failed/);
  });

  it('names malformed linear output', async () => {
    const { fake, directory, read } = await appliedPlan();

    fake.overrideOutput('api', 'not json');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/not JSON: not json/);
  });

  it('names linear output with missing fields', async () => {
    const { fake, directory, read } = await appliedPlan();

    fake.overrideOutput('api', JSON.stringify({ data: { issue: { identifier: 'ME-1' } } }));
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/unexpected output/);
  });

  it.each([
    {
      problem: 'command failure',
      output: undefined,
      diagnostic: 'network error',
    },
    {
      problem: 'invalid JSON',
      output: 'x'.repeat(250),
      diagnostic: 'x'.repeat(200),
    },
    {
      problem: 'invalid state type',
      output: '{"state": 1}',
      diagnostic: '/state',
    },
  ])(
    'reports the GitHub diagnostic for $problem without changing the draft',
    async ({ output, diagnostic }) => {
      const { fake, directory, read } = await appliedPlan();
      const url = 'https://github.com/sQVe/tau/pull/1';

      fake.issues.get('ME-2')!.pullRequests = [url];

      if (output === undefined) {
        fake.failCall('pr view', 'network error');
      } else {
        fake.overrideOutput('pr view', output);
      }

      const outcome = await expectReadOnly(fake, directory, read);

      expect(outcome.error).toContain(`gh pr view ${url}`);
      expect(outcome.error).toContain(diagnostic);

      expect(outcome.error).not.toContain('x'.repeat(201));
    },
  );

  it('names malformed gh output', async () => {
    const { fake, directory, read } = await appliedPlan();

    fake.issues.get('ME-2')!.pullRequests = ['https://github.com/sQVe/tau/pull/1'];
    fake.overrideOutput('pr view', '{"status": "MERGED"}');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/gh pr view .* unexpected output/);
  });

  it('reads the previous draft format', async () => {
    const { fake, directory, read } = await setUp('version-1.json');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome).toMatchObject({
      value: {
        draft: { version: 1 },
        writes: [
          { kind: 'createContainer' },
          { kind: 'createSlice', number: 1 },
          { kind: 'createSlice', number: 2 },
          { kind: 'addBlockedBy', number: 2, blocker: 1 },
        ],
      },
    });

    const { writes } = outcome.value!;

    expect(writes.every((write) => typeof write.text === 'string')).toBe(true);
  });

  it('rejects a newer draft format', async () => {
    const { fake, directory, read } = await setUp('newer.json');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/newer format/);
  });

  it('rejects a malformed draft', async () => {
    const { fake, directory, read } = await setUp('malformed.json');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/Malformed slice draft .*plan\.json/);
  });
});

const setUpContainerWithChildren = async (sliceIdentifier: string | null) => {
  const setup = await setUp();

  setup.fake.addIssue({ identifier: 'ME-1', title: 'Container' });
  setup.fake.addIssue({ identifier: 'ME-2', title: 'Slice one', parent: 'ME-1' });
  setup.fake.addIssue({ identifier: 'ME-3', title: 'Slice two', parent: 'ME-1' });

  await writeFile(
    join(setup.directory, 'plan.json'),
    JSON.stringify({
      version: 1,
      route: { team: 'ME', project: 'Tau' },
      container: { identifier: 'ME-1', title: 'Container', file: 'container.md' },
      slices: [
        { identifier: sliceIdentifier, title: 'Slice two', file: 'slice-2.md', blockedBy: [] },
      ],
    }),
  );

  return setup;
};

// Reads a state token on complete lists, then imposes the page limit. The returned apply uses that
// token, so it runs the apply action instead of failing in its own read.
const limitAfterRead = async (
  setup: Awaited<ReturnType<typeof setUpContainerWithChildren>>,
  limitPages: () => void,
) => {
  const { fake, context, directory } = setup;
  const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));

  limitPages();

  return () => run(fake, context, { action: 'apply', directory, stateToken: stateToken });
};

describe('slice tool Linear pages', () => {
  it('refuses to create a slice whose title matches a child on a later page', async () => {
    const setup = await setUpContainerWithChildren(null);

    const applyAfterLimit = await limitAfterRead(setup, () => {
      setup.fake.limitChildren(1);
    });

    await expect(setup.read()).rejects.toThrow('more than one Linear page');
    await expect(applyAfterLimit()).rejects.toThrow('more than one Linear page');
    expect(setup.fake.writes()).toEqual([]);
  });

  it('refuses a recorded child on a later page with the page message', async () => {
    const setup = await setUpContainerWithChildren('ME-3');

    const applyAfterLimit = await limitAfterRead(setup, () => {
      setup.fake.limitChildren(1);
    });

    await expect(setup.read()).rejects.toThrow('more than one Linear page');
    await expect(applyAfterLimit()).rejects.toThrow('more than one Linear page');
    expect(setup.fake.writes()).toEqual([]);
  });

  it('refuses when the container has more attachments than one page', async () => {
    const setup = await setUpContainerWithChildren(null);

    setup.fake.issues.get('ME-1')!.pullRequests = [
      'https://github.com/sQVe/tau/pull/1',
      'https://github.com/sQVe/tau/pull/2',
    ];

    const applyAfterLimit = await limitAfterRead(setup, () => {
      setup.fake.limitAttachments(1);
    });

    await expect(setup.read()).rejects.toThrow('more than one Linear page');
    await expect(applyAfterLimit()).rejects.toThrow('more than one Linear page');
    expect(setup.fake.writes()).toEqual([]);
  });

  it('refuses when a child has more attachments than one page', async () => {
    const setup = await setUpContainerWithChildren(null);

    setup.fake.issues.get('ME-3')!.pullRequests = [
      'https://github.com/sQVe/tau/pull/1',
      'https://github.com/sQVe/tau/pull/2',
    ];

    const applyAfterLimit = await limitAfterRead(setup, () => {
      setup.fake.limitAttachments(1);
    });

    await expect(setup.read()).rejects.toThrow('more than one Linear page');
    await expect(applyAfterLimit()).rejects.toThrow('more than one Linear page');
    expect(setup.fake.writes()).toEqual([]);
  });

  it('refuses when a child has more relations than one page', async () => {
    const setup = await setUpContainerWithChildren(null);

    setup.fake.issues.get('ME-3')!.blockedBy = ['ME-2', 'ME-4'];

    const applyAfterLimit = await limitAfterRead(setup, () => {
      setup.fake.limitRelations(1);
    });

    await expect(setup.read()).rejects.toThrow('more than one Linear page');
    await expect(applyAfterLimit()).rejects.toThrow('more than one Linear page');
    expect(setup.fake.writes()).toEqual([]);
  });
});
