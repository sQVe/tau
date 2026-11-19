import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { readSyncedGuides } from '../src/instructions/syncedGuides.js';

const bundle = fileURLToPath(new URL('../vendor/stomme', import.meta.url));

const advice =
  'vendor/stomme is not the stomme 0.2.0 bundle. Do not edit it by hand. Generate it with `mise exec github:sQVe/stomme@0.2.0 -- stomme guides vendor/stomme`.';

const bundledFiles = () =>
  readdirSync(bundle, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(bundle, join(entry.parentPath, entry.name)))
    .filter((path) => path !== '.sync-record.toml')
    .toSorted();

it('the bundled guides match their record', async () => {
  const guides = await readSyncedGuides(bundle);
  const recorded = guides.kind === 'valid' ? [...guides.files.keys()].toSorted() : [];

  expect(guides, advice).toMatchObject({ kind: 'valid', version: '0.2.0' });
  expect(bundledFiles(), advice).toEqual(recorded);
});
