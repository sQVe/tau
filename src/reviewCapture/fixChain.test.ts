import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { createFreshTauDirectory } from '../tauDirectory.js';
import { captureGeneration } from './generation.js';
import {
  generationFolderName,
  generationInputFileName,
  inputFileName,
  recordFileName,
} from './record.js';
import type { ReviewTarget } from './target.js';

const beforeAppend = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined }));

const afterRead = vi.hoisted(() => ({
  path: '',
  run: undefined as (() => Promise<void>) | undefined,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    readFile: (async (...parameters: Parameters<typeof actual.readFile>) => {
      const bytes = await actual.readFile(...parameters);
      const run = parameters[0] === afterRead.path ? afterRead.run : undefined;

      if (run !== undefined) {
        afterRead.run = undefined;
        await run();
      }

      return bytes;
    }) as typeof actual.readFile,
    appendFile: async (...parameters: Parameters<typeof actual.appendFile>) => {
      const run = beforeAppend.run;

      beforeAppend.run = undefined;
      await run?.();

      return actual.appendFile(...parameters);
    },
  };
});

const inputHeader = '# Review input\n\n## Capture\n';

const writeAt = async (root: string, path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

const changedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAt(root, 'src/kept.ts', 'one\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await writeAt(root, 'src/kept.ts', 'two\n');

  return root;
};

const prepareDirectory = async (root: string) => {
  const directory = await createFreshTauDirectory(root, 'workers', 'review-');

  await writeFile(join(directory, inputFileName), inputHeader);

  return directory;
};

const capturedReview = async (root: string, target: ReviewTarget) => {
  const directory = await prepareDirectory(root);

  await captureGeneration(root, directory, target);

  return directory;
};

const fixTarget = (review: string): ReviewTarget => ({
  kind: 'fix',
  review,
  findingPaths: ['src/kept.ts'],
});

const readTree = async (directory: string): Promise<[string, Buffer][]> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());

  return Promise.all(
    files
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted()
      .map(async (path) => [relative(directory, path), await readFile(path)] as [string, Buffer]),
  );
};

const refusal = async (root: string, review: string) => {
  const directory = await prepareDirectory(root);
  const before = await readTree(review);

  const refused = await captureGeneration(root, directory, fixTarget(review)).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(await readdir(directory)).not.toContain(recordFileName);
  expect(await readTree(review)).toEqual(before);
  expect(refused).toBeInstanceOf(Error);

  return (refused as Error).message;
};

it('refuses a fix capture of a predecessor whose saved input changed', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
  const savedInput = join(review, generationFolderName, generationInputFileName);
  const bytes = await readFile(savedInput);

  bytes[0] = (bytes[0] ?? 0) ^ 1;
  await writeFile(savedInput, bytes);
  await writeAt(root, 'src/kept.ts', 'three\n');

  expect(await refusal(root, review)).toContain('altered');
});

it('refuses a fix capture of a predecessor whose capture record is gone', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });

  await rm(join(review, recordFileName));
  await writeAt(root, 'src/kept.ts', 'three\n');

  expect(await refusal(root, review)).toContain('incomplete');
});

it('refuses a fix capture whose predecessor record is replaced before publishing', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
  const recordPath = join(review, recordFileName);
  const replaced = `${JSON.stringify(JSON.parse(await readFile(recordPath, 'utf8')))}\n`;

  await writeAt(root, 'src/kept.ts', 'three\n');

  let replacedTree: [string, Buffer][] = [];

  beforeAppend.run = async () => {
    await writeFile(recordPath, replaced);
    replacedTree = await readTree(review);
  };

  const directory = await prepareDirectory(root);

  await expect(captureGeneration(root, directory, fixTarget(review))).rejects.toThrow('altered');
  expect(await readdir(directory)).toEqual([inputFileName]);
  expect(await readFile(join(directory, inputFileName), 'utf8')).toBe(inputHeader);
  expect(await readTree(review)).toEqual(replacedTree);
  expect(replacedTree).toContainEqual([recordFileName, Buffer.from(replaced)]);
});

const readRecord = async (directory: string) =>
  JSON.parse(await readFile(join(directory, recordFileName), 'utf8')) as Record<string, unknown>;

it('refuses a fix capture with no complete endpoint as a predecessor', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
  const { endpoint: _endpoint, ...saved } = await readRecord(review);

  await writeFile(join(review, recordFileName), JSON.stringify({ ...saved, version: 3 }));
  await writeAt(root, 'src/kept.ts', 'three\n');

  const fix = await capturedReview(root, fixTarget(review));

  await writeAt(root, 'src/kept.ts', 'four\n');

  expect(await refusal(root, fix)).toContain('fix capture with no complete endpoint');
});

it('names a complete predecessor in the published fix record', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
  const identity = await git(root, 'hash-object', join(review, recordFileName));
  const { endpoint } = (await readRecord(review)) as { endpoint: { tree: string } };

  await writeAt(root, 'src/kept.ts', 'three\n');

  const fix = await capturedReview(root, fixTarget(review));

  expect(await readRecord(fix)).toMatchObject({
    version: 5,
    target: { kind: 'fix', review, predecessor: { review, identity, endpointTree: endpoint.tree } },
  });
});

it('captures a fix of a version 3 predecessor without naming it', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
  const { endpoint: _endpoint, ...saved } = await readRecord(review);

  await writeFile(join(review, recordFileName), JSON.stringify({ ...saved, version: 3 }));
  await writeAt(root, 'src/kept.ts', 'three\n');

  const fix = await capturedReview(root, fixTarget(review));
  const record = await readRecord(fix);
  const patch = await readFile(join(fix, generationFolderName, 'patch.diff'), 'utf8');

  expect(record).toMatchObject({ version: 5, target: { kind: 'fix', review } });
  expect(record['target']).not.toHaveProperty('predecessor');
  expect(patch).toContain('-two\n+three\n');
});

it('refuses a fix capture of a files predecessor that saved no snapshot', async () => {
  const root = await changedRepository();
  const target: ReviewTarget = { kind: 'files', paths: ['src/kept.ts'], base: 'HEAD' };
  const review = await capturedReview(root, target);
  const { snapshot: _snapshot, ...saved } = await readRecord(review);

  await writeFile(join(review, recordFileName), JSON.stringify(saved));
  await writeAt(root, 'src/kept.ts', 'three\n');

  expect(await refusal(root, review)).toContain('no snapshot');
});

const versionTwoRecord = async (review: string) => {
  const {
    gaps: _gaps,
    original: _original,
    endpoint: _endpoint,
    ...rest
  } = await readRecord(review);

  return JSON.stringify({ ...rest, version: 2 });
};

const refusedFixDirectory = async (root: string, review: string) => {
  const directory = await prepareDirectory(root);

  await expect(captureGeneration(root, directory, fixTarget(review))).rejects.toThrow(
    'Nothing was written',
  );

  return readdir(directory);
};

it('refuses a fix capture whose predecessor turns into a version 2 record while it is pinned', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
  const recordPath = join(review, recordFileName);
  const downgraded = await versionTwoRecord(review);

  await writeAt(root, 'src/kept.ts', 'three\n');

  afterRead.path = recordPath;
  afterRead.run = () => writeFile(recordPath, downgraded);

  expect(await refusedFixDirectory(root, review)).toEqual([inputFileName]);
});

it('refuses a fix capture whose predecessor turns into a version 2 record before publishing', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
  const recordPath = join(review, recordFileName);
  const downgraded = await versionTwoRecord(review);

  await writeAt(root, 'src/kept.ts', 'three\n');

  beforeAppend.run = () => writeFile(recordPath, downgraded);

  expect(await refusedFixDirectory(root, review)).toEqual([inputFileName]);
});

it.each([
  { change: 'removed', run: (recordPath: string) => rm(recordPath) },
  {
    change: 'replaced',
    run: async (recordPath: string) =>
      writeFile(recordPath, JSON.stringify(JSON.parse(await readFile(recordPath, 'utf8')))),
  },
])(
  'refuses a fix capture whose version 3 predecessor record is $change before publishing',
  async ({ run }) => {
    const root = await changedRepository();
    const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
    const recordPath = join(review, recordFileName);
    const { endpoint: _endpoint, ...saved } = await readRecord(review);

    await writeFile(recordPath, `${JSON.stringify({ ...saved, version: 3 }, null, 2)}\n`);
    await writeAt(root, 'src/kept.ts', 'three\n');

    beforeAppend.run = () => run(recordPath);

    expect(await refusedFixDirectory(root, review)).toEqual([inputFileName]);
  },
);

it('names a complete version 4 predecessor in the published fix record', async () => {
  const root = await changedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });
  const recordPath = join(review, recordFileName);
  const saved = await readRecord(review);
  const { endpoint } = saved as { endpoint: { tree: string } };

  await writeFile(recordPath, `${JSON.stringify({ ...saved, version: 4 }, null, 2)}\n`);
  await writeAt(root, 'src/kept.ts', 'three\n');

  const identity = await git(root, 'hash-object', recordPath);
  const fix = await capturedReview(root, fixTarget(review));

  expect(await readRecord(fix)).toMatchObject({
    version: 5,
    target: { kind: 'fix', review, predecessor: { review, identity, endpointTree: endpoint.tree } },
  });
});
