import { cp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appliedPlan,
  outsideDirectory,
  readDetails,
  run,
  savedPlan,
  setUp,
} from './fixtures/sliceToolHarness.js';

describe('slice tool apply', () => {
  it('creates the container and slices in order and records each identifier', async () => {
    const { root, fake, directory } = await appliedPlan();

    expect(directory).toBe(join(root, '.tau', 'slices', 'me-1'));

    expect(await savedPlan(directory)).toMatchObject({
      container: { identifier: 'ME-1' },
      slices: [{ identifier: 'ME-2' }, { identifier: 'ME-3' }],
    });

    expect(fake.issues.get('ME-1')).toMatchObject({ parent: null, projectId: 'project-tau' });

    expect(fake.issues.get('ME-2')).toMatchObject({
      parent: 'ME-1',
      teamId: 'team-me',
      projectId: 'project-tau',
      description: 'Slice one.\n',
    });

    expect(fake.issues.get('ME-3')).toMatchObject({ parent: 'ME-1', blockedBy: ['ME-2'] });
  });

  it('creates the container in the route project when another team has a project with that name', async () => {
    const { fake, apply } = await setUp();

    fake.addProject({ id: 'project-other-tau', name: 'Tau', teamId: 'team-other' });
    await apply();

    expect(fake.issues.get('ME-1')).toMatchObject({ teamId: 'team-me', projectId: 'project-tau' });
  });

  it('refuses when the container project differs from the route', async () => {
    const { fake, directory, read, apply } = await appliedPlan();

    fake.issues.get('ME-1')!.projectId = null;

    await expect(read()).resolves.toMatchObject({
      problems: [expect.stringMatching(/ME-1 is in team ME and no project/)],
    });

    await expect(apply(undefined, directory)).rejects.toThrow(/no project/);
  });

  it('refuses when Linear changed since the read', async () => {
    const { fake, context, directory } = await appliedPlan();
    const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));

    fake.issues.get('ME-2')!.title = 'Renamed in Linear';
    const writesBefore = fake.writes().length;

    await expect(
      run(fake, context, { action: 'apply', directory, stateToken: stateToken }),
    ).rejects.toThrow(/changed since the read/);

    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('refuses when the draft changed since the read', async () => {
    const { fake, context, directory } = await setUp();
    const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));

    await writeFile(join(directory, 'slice-1.md'), 'Changed after the read.\n');

    await expect(
      run(fake, context, { action: 'apply', directory, stateToken: stateToken }),
    ).rejects.toThrow(/changed since the read/);

    expect(fake.writes()).toEqual([]);
  });

  it('refuses when the draft directory became a symlink since the read', async () => {
    const { fake, context, directory } = await setUp();
    const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));
    const outside = await outsideDirectory();
    const originalPlan = await savedPlan(directory);

    await cp(directory, outside, { recursive: true });
    await rm(directory, { recursive: true });
    await symlink(outside, directory);

    await expect(
      run(fake, context, { action: 'apply', directory, stateToken: stateToken }),
    ).rejects.toThrow(/symlink/u);

    expect(fake.writes()).toEqual([]);
    expect(await savedPlan(outside)).toEqual(originalPlan);
  });

  it('refuses to create a slice whose title matches an unrecorded child', async () => {
    const { fake, directory, apply } = await appliedPlan();
    const plan = await savedPlan(directory);

    plan.slices[1]!.identifier = null;
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
    const writesBefore = fake.writes().length;

    await expect(apply(undefined, directory)).rejects.toThrow(/ME-3 under ME-1 has the same title/);
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('reports the new title and the body file of an applied update', async () => {
    const { fake, directory, apply } = await appliedPlan();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      slices: { title: string }[];
    };

    plan.slices[0]!.title = 'Record the renamed lifecycle';
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');

    const result = await apply(undefined, directory);
    const applied = result.applied;
    const texts = applied.map((step) => step.text).join('\n');

    expect(texts).toContain('Record the renamed lifecycle');
    expect(texts).toContain('slice-2.md');
    expect(texts).not.toContain('Slice two, revised.');
    expect(fake.issues.get('ME-2')?.title).toBe('Record the renamed lifecycle');
  });

  it('never changes a merged slice', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.pullRequests = ['https://github.com/sQVe/tau/pull/1'];
    fake.mergedPullRequests.add('https://github.com/sQVe/tau/pull/1');
    await writeFile(join(directory, 'slice-1.md'), 'Changed after merge.\n');
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);

    expect(result['status']).toBe('unchanged');
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('updates a changed unmerged slice and its dependencies', async () => {
    const { fake, directory, apply } = await appliedPlan();

    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');
    const plan = await savedPlan(directory);

    await writeFile(
      join(directory, 'plan.json'),
      JSON.stringify({
        ...plan,
        slices: plan.slices.map((slice) => Object.assign(slice, { blockedBy: [] })),
      }),
    );

    await apply(undefined, directory);

    expect(fake.issues.get('ME-3')).toMatchObject({
      description: 'Slice two, revised.\n',
      blockedBy: [],
    });
  });

  it('names the route project of a new container in the applied steps', async () => {
    const { apply } = await setUp();

    const result = await apply();
    const applied = result.applied;

    expect(applied[0]?.text).toContain('in team ME and project Tau');
  });

  it('never changes a merged one-slice ticket', async () => {
    const { fake, directory, read, apply } = await setUp();
    const url = 'https://github.com/sQVe/tau/pull/7';

    fake.addIssue({
      identifier: 'ME-1',
      title: 'Old title',
      description: 'Old.\n',
      pullRequests: [url],
    });

    fake.mergedPullRequests.add(url);

    await writeFile(
      join(directory, 'plan.json'),
      JSON.stringify({
        version: 1,
        route: { team: 'ME', project: 'Tau' },
        container: { identifier: 'ME-1', title: 'New title', file: 'container.md' },
        slices: [],
      }),
    );

    await expect(read()).resolves.toMatchObject({ writes: [], problems: [] });
    await apply(undefined, directory);

    expect(fake.writes()).toEqual([]);
    expect(fake.issues.get('ME-1')).toMatchObject({ title: 'Old title', description: 'Old.\n' });
  });

  it('keeps agent children out of dropped slices', async () => {
    const { fake, directory, read } = await setUp();

    fake.addIssue({ identifier: 'ME-1', title: 'Container' });
    fake.addIssue({ identifier: 'ME-2', title: 'Slice', parent: 'ME-1' });

    fake.addIssue({
      identifier: 'AI-1',
      title: 'Agent task',
      parent: 'ME-1',
      teamId: 'team-ai',
      projectId: null,
    });

    await writeFile(
      join(directory, 'plan.json'),
      JSON.stringify({
        version: 1,
        route: { team: 'ME', project: 'Tau' },
        container: { identifier: 'ME-1', title: 'Container', file: 'container.md' },
        slices: [{ identifier: 'ME-2', title: 'Slice', file: 'slice-1.md', blockedBy: [] }],
      }),
    );

    await expect(read()).resolves.toMatchObject({ dropped: [], problems: [] });
  });

  it('creates every slice before it marks one blocked by a later slice', async () => {
    const { fake, directory, apply } = await setUp();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      slices: { blockedBy: number[] }[];
    };

    plan.slices[0]!.blockedBy = [2];
    plan.slices[1]!.blockedBy = [];
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    await apply();

    expect(fake.issues.get('ME-2')).toMatchObject({ blockedBy: ['ME-3'] });
  });

  it('creates tickets whose titles look like other JSON values', async () => {
    const { fake, directory, apply } = await setUp();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      container: { title: string };
      slices: { title: string }[];
    };

    plan.container.title = '123';
    plan.slices[0]!.title = 'true';
    plan.slices[1]!.title = 'null';
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    await apply();

    expect(
      ['ME-1', 'ME-2', 'ME-3'].map((identifier) => fake.issues.get(identifier)?.title),
    ).toEqual(['123', 'true', 'null']);
  });
});
