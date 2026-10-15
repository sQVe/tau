import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { parseReviewManifest } from './stage.js';

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
