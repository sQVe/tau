import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createTemporaryRepository, initializeRepository } from '../../../tests/gitRepository.js';
import { writeStommeProject } from '../../../tests/stommeProject.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { resolveStommeGuides } from './stommeGuides.js';

const sha256Hex = /^[\da-f]{64}$/;

const digestOf = async (cwd: string): Promise<string> => {
  const snapshot = await resolveStommeGuides(cwd);

  expect(snapshot.kind).not.toBe('broken');

  return snapshot.kind === 'broken' ? snapshot.reason : snapshot.digest;
};

it('finds stomme.toml from a subfolder of the repository', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'rust' });
  const subfolder = join(repository, 'src', 'deep');
  await mkdir(subfolder, { recursive: true });

  const snapshot = await resolveStommeGuides(subfolder);

  expect(snapshot).toMatchObject({ kind: 'project', root: repository, language: 'rust' });
});

it('ignores a stomme.toml above the repository top level', async ({ onTestFinished }) => {
  const outer = temporaryDirectory(onTestFinished, 'tau-stomme-outer-');
  await writeStommeProject(outer, { language: 'rust' });
  const repository = join(outer, 'repository');
  await mkdir(repository);
  await initializeRepository(repository);

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot.kind).toBe('bundle');
});

it('reads only the working directory outside Git', async ({ onTestFinished }) => {
  const outer = temporaryDirectory(onTestFinished, 'tau-stomme-outer-');
  await writeStommeProject(outer, { language: 'rust' });
  const subfolder = join(outer, 'subfolder');
  await mkdir(subfolder);

  const fromSubfolder = await resolveStommeGuides(subfolder);
  const fromRoot = await resolveStommeGuides(outer);

  expect(fromSubfolder.kind).toBe('bundle');
  expect(fromRoot).toMatchObject({ kind: 'project', root: outer });
});

it('returns the bundle without stomme.toml', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot).toMatchObject({ kind: 'bundle', version: '0.2.0' });
  const digest = snapshot.kind === 'bundle' ? snapshot.digest : '';

  expect(digest).toMatch(sha256Hex);
});

it('reports an edited project guide as broken, never as the bundle', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'rust' });
  await appendFile(join(repository, 'docs', 'stomme', 'languages', 'rust', 'guide.md'), 'edit\n');

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot).toMatchObject({ kind: 'broken', root: repository });
  const reason = snapshot.kind === 'broken' ? snapshot.reason : '';

  expect(reason).toContain('differs from its record');
});

it('gives equal projects one digest', async ({ onTestFinished }) => {
  const first = await createTemporaryRepository(onTestFinished);
  const second = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(first, { language: 'rust', layers: ['gpui'] });
  await writeStommeProject(second, { language: 'rust', layers: ['gpui'] });

  const firstDigest = await digestOf(first);

  expect(firstDigest).toMatch(sha256Hex);
  expect(await digestOf(second)).toBe(firstDigest);
});

it('keeps the digest when an unselected layer guide is added', async ({ onTestFinished }) => {
  const plain = await createTemporaryRepository(onTestFinished);
  const withLayer = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(plain, { language: 'rust' });
  await writeStommeProject(withLayer, { language: 'rust', recordedLayers: ['gpui'] });

  expect(await digestOf(withLayer)).toBe(await digestOf(plain));
});

it('changes the digest when a layer is selected', async ({ onTestFinished }) => {
  const plain = await createTemporaryRepository(onTestFinished);
  const withLayer = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(plain, { language: 'rust' });
  await writeStommeProject(withLayer, { language: 'rust', layers: ['gpui'] });

  expect(await digestOf(withLayer)).not.toBe(await digestOf(plain));
});

it('changes the digest when the version changes', async ({ onTestFinished }) => {
  const current = await createTemporaryRepository(onTestFinished);
  const newer = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(current, { language: 'rust' });
  await writeStommeProject(newer, { language: 'rust', version: '0.2.1' });

  expect(await digestOf(newer)).not.toBe(await digestOf(current));
});
