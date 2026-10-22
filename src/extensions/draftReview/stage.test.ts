import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import {
  parseReviewManifest,
  readReview,
  savePlacement,
  saveProcessIds,
  stageReview,
} from './stage.js';
import type { Review } from './stage.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'review');
const path = '/record/review.json';

const fixtureText = (name: string) => readFile(join(fixtures, name), 'utf8');

const stagedFixture = async () => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-stage-repo-');
  const data = await mkdtemp(join(tmpdir(), 'tau-stage-data-'));
  onTestFinished(() => rm(data, { recursive: true, force: true }));
  vi.stubEnv('TMPDIR', data);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await mkdir(join(repository, '.tau/slices'), { recursive: true });
  await writeFile(join(repository, '.tau/slices/a.md'), 'one\n');

  return { repository, data };
};

it.each([
  'slices/../../outside.md',
  '..\\outside.md',
  'a\\b/../../outside.md',
  '/etc/passwd',
  '\\outside.md',
  '.\\..\\outside.md',
  'x\\\\..\\..\\outside.md',
  'a\\b/../..',
])('refuses a saved manifest path that climbs out of .tau: %s', async (climbing) => {
  const { repository } = await stagedFixture();
  const review = await stageReview(repository, ['.tau/slices/a.md']);
  const manifestPath = join(review.recordDirectory, 'review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { paths: string[] };

  manifest.paths = [climbing];
  await writeFile(manifestPath, JSON.stringify(manifest));

  await expect(readReview(repository, review.recordDirectory)).rejects.toThrow(
    /names a path outside \.tau/,
  );
});

it('reads a version 3 manifest with its staged paths', async () => {
  expect(parseReviewManifest(path, await fixtureText('version-3.json'))).toEqual({
    version: 3,
    stagingDirectory: '/tmp/tau-draft-review-abc123',
    paths: ['slices/a.md', 'tickets/c.md'],
    stagedPaths: ['01-slices/1-a.md', '02-tickets/1-c.md'],
    placement: { kind: 'split', terminalId: 't1' },
  });
});

it('refuses a version 3 manifest without a staged path for each path', () => {
  const text = JSON.stringify({
    version: 3,
    stagingDirectory: '/tmp/x',
    paths: ['a.md', 'b.md'],
    stagedPaths: ['01-a.md'],
    placement: null,
  });

  expect(() => parseReviewManifest(path, text)).toThrow(/Malformed review record.*stagedPaths/);
});

it('reads a version 2 manifest with a tab placement and its paths as staged paths', async () => {
  expect(parseReviewManifest(path, await fixtureText('version-2.json'))).toEqual({
    version: 2,
    stagingDirectory: '/tmp/tau-draft-review-abc123',
    paths: ['slices/a.md', 'tickets/c.md'],
    stagedPaths: ['slices/a.md', 'tickets/c.md'],
    placement: {
      kind: 'tab',
      terminalId: 't1',
      tabId: 'tab2',
      agentTabId: 'tab1',
      processIds: [4242],
    },
  });
});

it('reads a version 1 manifest with no placement and its paths as staged paths', async () => {
  expect(parseReviewManifest(path, await fixtureText('version-1.json'))).toEqual({
    version: 1,
    stagingDirectory: '/tmp/tau-draft-review-abc123',
    paths: ['slices/a.md', 'tickets/c.md'],
    stagedPaths: ['slices/a.md', 'tickets/c.md'],
    placement: null,
  });
});

it('refuses a version 1 manifest that holds a placement', () => {
  const text =
    '{"version":1,"stagingDirectory":"/tmp/x","paths":["a.md"],"placement":{"kind":"split","terminalId":"t"}}';

  expect(() => parseReviewManifest(path, text)).toThrow(/Malformed review record/);
});

it.each([
  { label: 'an unknown kind', placement: { kind: 'window', terminalId: 't' } },
  { label: 'no terminal id', placement: { kind: 'split' } },
  {
    label: 'a process ID that is not a number',
    placement: { kind: 'split', terminalId: 't', processIds: ['4'] },
  },
])('refuses a placement with $label, naming the path', ({ placement }) => {
  const text = JSON.stringify({
    version: 2,
    stagingDirectory: '/tmp/x',
    paths: ['a.md'],
    placement,
  });

  expect(() => parseReviewManifest(path, text)).toThrow(
    /Malformed review record \/record\/review.json/,
  );
});

it('refuses a version 2 manifest without a placement', () => {
  const text = '{"version":2,"stagingDirectory":"/tmp/x","paths":["a.md"]}';

  expect(() => parseReviewManifest(path, text)).toThrow(/Malformed review record/);
});

it('reads back a saved split placement with the same paths and staging directory', async () => {
  const { repository } = await stagedFixture();
  const review = await stageReview(repository, ['.tau/slices/a.md']);
  const placement = { kind: 'split', terminalId: 't9' } as const;

  expect((await readReview(repository, review.recordDirectory)).placement).toBeNull();

  await savePlacement(review, placement);

  const read = await readReview(repository, review.recordDirectory);

  expect(read).toEqual({ ...review, placement });
});

it('reads back process IDs saved into the placement', async () => {
  const { repository } = await stagedFixture();
  const review = await stageReview(repository, ['.tau/slices/a.md']);

  await expect(saveProcessIds(review, [7])).rejects.toThrow(review.recordDirectory);

  await savePlacement(review, { kind: 'split', terminalId: 't9' });
  await saveProcessIds(review, [7, 8]);

  const read = await readReview(repository, review.recordDirectory);

  expect(read.placement).toEqual({ kind: 'split', terminalId: 't9', processIds: [7, 8] });
});

it('refuses a malformed fixture, naming the path', async () => {
  expect(() => parseReviewManifest(path, '{}')).toThrow(
    /Malformed review record \/record\/review.json/,
  );

  expect(() => parseReviewManifest(path, '{')).toThrow(/Malformed review record .*not JSON/);
  const fixture = await fixtureText('malformed.json');

  expect(() => parseReviewManifest(path, fixture)).toThrow(
    /Malformed review record \/record\/review.json/,
  );
});

it('refuses a newer fixture with its own error', async () => {
  const text = await fixtureText('newer.json');

  expect(() => parseReviewManifest(path, text)).toThrow(/newer format/);
});

it('refuses an unknown field', () => {
  const text = '{"version":1,"stagingDirectory":"/tmp/x","paths":["a.md"],"x":1}';

  expect(() => parseReviewManifest(path, text)).toThrow(/Malformed review record/);
});

const tamperManifest = async (review: Review, changes: Record<string, unknown>) => {
  const manifestPath = join(review.recordDirectory, 'review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;

  await writeFile(manifestPath, JSON.stringify({ ...manifest, ...changes }));
};

it('refuses a safe path list that holds one path climbing out of .tau', async () => {
  const { repository } = await stagedFixture();
  const review = await stageReview(repository, ['.tau/slices/a.md']);

  await tamperManifest(review, {
    paths: ['slices/a.md', '../outside.md'],
    stagedPaths: ['01-slices/1-a.md', '02-outside.md'],
  });

  await expect(readReview(repository, review.recordDirectory)).rejects.toThrow(
    /names a path outside \.tau/,
  );
});

it('refuses a staged path that climbs out of the staging directory', async () => {
  const { repository } = await stagedFixture();
  const review = await stageReview(repository, ['.tau/slices/a.md']);

  await tamperManifest(review, {
    paths: ['slices/a.md', 'slices/b.md'],
    stagedPaths: ['01-slices/1-a.md', '../outside.md'],
  });

  await expect(readReview(repository, review.recordDirectory)).rejects.toThrow(
    /staged path outside its staging directory/,
  );
});

it('reads a manifest whose paths wander but stay inside .tau', async () => {
  const { repository } = await stagedFixture();
  const review = await stageReview(repository, ['.tau/slices/a.md']);
  const paths = ['slices/a.md', 'a/b/../../c.md', 'a//./b.md'];

  await tamperManifest(review, { paths, stagedPaths: paths });

  expect((await readReview(repository, review.recordDirectory)).paths).toEqual(paths);
});

it.each(['outside the temporary directory', 'without the prefix', 'inside a staging directory'])(
  'refuses a manifest naming a staging directory Tau did not create (%s) and keeps it',
  async (kind) => {
    const { repository, data } = await stagedFixture();
    const review = await stageReview(repository, ['.tau/slices/a.md']);

    const directories: Record<string, () => Promise<string>> = {
      'outside the temporary directory': () => mkdtemp(join(repository, 'tau-draft-review-')),
      'without the prefix': () => mkdtemp(join(data, 'precious-')),
      'inside a staging directory': async () => {
        const nested = join(review.stagingDirectory, 'tau-draft-review-nested');

        await mkdir(nested);

        return nested;
      },
    };

    const stagingDirectory = (await directories[kind]?.()) ?? '';

    await tamperManifest(review, { stagingDirectory });

    await expect(readReview(repository, review.recordDirectory)).rejects.toThrow(
      /staging directory it did not create/,
    );

    expect(existsSync(stagingDirectory)).toBe(true);
  },
);

it('stages a file whose name already uses the 255 bytes a name may hold', async () => {
  const { repository } = await stagedFixture();
  const name = `${'a'.repeat(252)}.md`;

  await writeFile(join(repository, '.tau', name), 'long\n');

  const review = await stageReview(repository, [`.tau/${name}`]);
  const [stagedPath = ''] = review.stagedPaths;

  expect(await readFile(join(review.stagingDirectory, stagedPath), 'utf8')).toBe('long\n');
});

it('refuses to review a file inside the draft_review record directory', async () => {
  const { repository } = await stagedFixture();
  const review = await stageReview(repository, ['.tau/slices/a.md']);
  const own = join(review.recordDirectory, 'review.json');

  await expect(stageReview(repository, [own])).rejects.toThrow(/cannot review its own records/);
});

it('names a missing review record, and rethrows other read errors as they are', async () => {
  const { repository } = await stagedFixture();
  const review = await stageReview(repository, ['.tau/slices/a.md']);
  const manifestPath = join(review.recordDirectory, 'review.json');

  await rm(manifestPath);

  await expect(readReview(repository, review.recordDirectory)).rejects.toThrow(
    /found no review record/,
  );

  await mkdir(manifestPath);

  await expect(readReview(repository, review.recordDirectory)).rejects.toThrow(/EISDIR/);
});

it('rethrows a path error that is not a missing file', async () => {
  const { repository } = await stagedFixture();

  await expect(stageReview(repository, ['.tau/slices/a.md/inside'])).rejects.toThrow(/ENOTDIR/);
});

it.each(['null', '5', '"text"', '{"version":"2","stagingDirectory":"/tmp/x","paths":["a.md"]}'])(
  'reads a manifest of %s as malformed, not newer',
  (text) => {
    expect(() => parseReviewManifest(path, text)).toThrow(/Malformed review record/);
  },
);

it.each([
  { label: 'an empty staging directory', stagingDirectory: '', paths: ['a.md'] },
  { label: 'an empty path', stagingDirectory: '/tmp/x', paths: [''] },
])('refuses a manifest with $label', ({ stagingDirectory, paths }) => {
  const text = JSON.stringify({ version: 1, stagingDirectory, paths });

  expect(() => parseReviewManifest(path, text)).toThrow(/Malformed review record/);
});
