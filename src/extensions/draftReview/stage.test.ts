import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { parseReviewManifest, readReview, stageReview } from './stage.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'review');
const path = '/record/review.json';

const fixtureText = (name: string) => readFile(join(fixtures, name), 'utf8');

it('reads a current manifest', async () => {
  expect(parseReviewManifest(path, await fixtureText('version-1.json'))).toEqual({
    version: 1,
    stagingDirectory: '/tmp/tau-draft-review-abc123',
    paths: ['slices/a.md', 'tickets/c.md'],
  });
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

it.each(['slices/../../outside.md', '..\\outside.md', 'a\\b/../../outside.md'])(
  'refuses a saved manifest path that climbs out of .tau: %s',
  async (climbing) => {
    const { repository } = await stagedFixture();
    const review = await stageReview(repository, ['.tau/slices/a.md']);
    const manifestPath = join(review.recordDirectory, 'review.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { paths: string[] };

    manifest.paths = [climbing];
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(readReview(repository, review.recordDirectory)).rejects.toThrow(
      /names a path outside \.tau/,
    );
  },
);
