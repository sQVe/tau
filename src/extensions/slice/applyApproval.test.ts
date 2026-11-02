import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { confirmContext } from '../../../tests/toolContext.js';
import { appliedPlan, setUp, snapshotDraft } from './fixtures/sliceToolHarness.js';

const asked = (root: string, answer: boolean) => {
  const seen: string[] = [];

  const context = confirmContext(root, async (title, message) => {
    seen.push(`${title}\n${message}`);

    return answer;
  });

  return { seen, context };
};

describe('slice tool apply ownership', () => {
  it('asks once before it writes to a slice another person owns, and writes nothing when declined', async () => {
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    vi.stubEnv('TAU_ROLE', undefined);
    vi.stubEnv('TAU_WORKER_RECORD', undefined);
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    const draftBefore = await snapshotDraft(directory);
    const writesBefore = fake.writes().length;
    const { seen, context } = asked(root, false);

    const result = await apply(context, directory);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('ME-2');
    expect(seen[0]).toContain('Update the description from slice-1.md of ME-2');
    expect(result).toMatchObject({ status: 'declined', applied: [] });
    expect(fake.writes()).toHaveLength(writesBefore);
    expect(await snapshotDraft(directory)).toEqual(draftBefore);
  });

  it('writes nothing and returns declined when no user can answer', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);

    expect(result).toMatchObject({ status: 'declined', applied: [] });
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('writes nothing and returns declined in a worker, which asks nothing', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    const writesBefore = fake.writes().length;
    const { seen, context } = asked(root, true);

    vi.stubEnv('TAU_ROLE', 'worker');
    vi.stubEnv('TAU_WORKER_RECORD', undefined);

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const result = await apply(context, directory);

    expect(seen).toEqual([]);
    expect(result).toMatchObject({ status: 'declined', applied: [] });
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('applies the writes to a slice another person owns after the user confirms', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    const { seen, context } = asked(root, true);

    const result = await apply(context, directory);

    expect(seen).toHaveLength(1);
    expect(result['status']).toBe('applied');
    expect(fake.issues.get('ME-2')!.description).toBe('Slice one, revised.\n');
  });

  it('asks before it writes to a container another person owns', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-1')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'container.md'), 'The design, revised.\n');
    const writesBefore = fake.writes().length;
    const { seen, context } = asked(root, false);

    const result = await apply(context, directory);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('ME-1');
    expect(result).toMatchObject({ status: 'declined', applied: [] });
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('shows the current Linear description and the new body of a foreign slice in the confirm', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    const { seen, context } = asked(root, false);

    await apply(context, directory);

    expect(seen[0]).toContain('ME-2 now holds:\n---\nSlice one.\n');
    expect(seen[0]).toContain('ME-2 will hold:\n---\nSlice one, revised.\n');
  });

  it('shows no body in the confirm for a foreign title-only edit', async () => {
    const { root, fake, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    fake.issues.get('ME-2')!.title = 'Old title';
    const { seen, context } = asked(root, false);

    await apply(context);

    expect(seen[0]).toContain('Update the title to "Record the lifecycle" of ME-2');
    expect(seen[0]).not.toContain('Body changes');
  });

  it('shows the body only for the foreign slice when the viewer also changes its own slice', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');
    const { seen, context } = asked(root, false);

    await apply(context, directory);

    expect(seen[0]).toContain('ME-3 will hold:\n---\nSlice two, revised.\n');
    expect(seen[0]).not.toContain('ME-2 now holds');
  });

  it('shows the current Linear description and the new body of a foreign container in the confirm', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-1')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'container.md'), 'The design, revised.\n');
    const { seen, context } = asked(root, false);

    await apply(context, directory);

    expect(seen[0]).toContain('ME-1 now holds:\n---\nThe design.\n');
    expect(seen[0]).toContain('ME-1 will hold:\n---\nThe design, revised.\n');
  });

  it('asks before it writes to a container whose owner is unknown', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-1')!.assigneeId = null;
    fake.issues.get('ME-1')!.creatorId = null;
    await writeFile(join(directory, 'container.md'), 'The design, revised.\n');
    const writesBefore = fake.writes().length;
    const { seen, context } = asked(root, false);

    const result = await apply(context, directory);

    expect(seen).toHaveLength(1);
    expect(result).toMatchObject({ status: 'declined', applied: [] });
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('asks before it adds a blocked-by relation whose blocker another person owns', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    fake.issues.get('ME-3')!.blockedBy = [];
    const writesBefore = fake.writes().length;
    const { seen, context } = asked(root, false);

    const result = await apply(context, directory);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('ME-2');
    expect(seen[0]).not.toContain('Body changes');
    expect(result).toMatchObject({ status: 'declined', applied: [] });
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('stops after the user confirms when the draft changed while they answered', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    const writesBefore = fake.writes().length;

    const context = confirmContext(root, async () => {
      await writeFile(join(directory, 'slice-1.md'), 'Slice one, edited while you answered.\n');

      return true;
    });

    await expect(apply(context, directory)).rejects.toThrow('Nothing was written.');

    expect(fake.writes()).toHaveLength(writesBefore);
    expect(fake.issues.get('ME-2')!.description).toBe('Slice one.\n');
  });

  it('stops after the user confirms when Linear changed while they answered', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    const writesBefore = fake.writes().length;

    const context = confirmContext(root, async () => {
      fake.addIssue({ identifier: 'ME-9', parent: 'ME-1', title: 'Other' });

      return true;
    });

    await expect(apply(context, directory)).rejects.toThrow(
      'Call read again. Nothing was written.',
    );

    expect(fake.writes()).toHaveLength(writesBefore);
    expect(fake.issues.get('ME-2')!.description).toBe('Slice one.\n');
  });

  it('applies a plan of creates without asking', async () => {
    const { root, fake, apply } = await setUp();
    const { seen, context } = asked(root, false);

    const result = await apply(context);

    expect(seen).toEqual([]);
    expect(result['status']).toBe('applied');
    expect(fake.issues.get('ME-2')!.description).toBe('Slice one.\n');
  });

  it('applies the container and slices the viewer owns without asking', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    await writeFile(join(directory, 'container.md'), 'The design, revised.\n');
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    const { seen, context } = asked(root, false);

    const result = await apply(context, directory);

    expect(seen).toEqual([]);
    expect(result['status']).toBe('applied');
    expect(fake.issues.get('ME-1')!.description).toBe('The design, revised.\n');
  });
});
