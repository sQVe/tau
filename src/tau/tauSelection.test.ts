import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import { writeFileMap } from '../../tests/fileMap.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { readTauArtifactKey, tauArtifactPath } from './tauArtifact.js';
import {
  isTauRegistrationModule,
  loadTauRegistration,
  resolveTauRegistration,
} from './tauSelection.js';
import type { TauRegistration } from './tauSelection.js';

interface SelectionFixture {
  root: string;
  key: string;
  artifact: string;
}

const packageFiles: Readonly<Record<string, string>> = {
  'package.json': '{"name":"tau-fixture"}\n',
  'tsconfig.json': '{}\n',
  'scripts/buildTauExtension.ts': 'export const build = 1;\n',
  'src/tau/tau.ts': 'export default 1;\n',
};

const createFixture = async (
  onTestFinished: (cleanup: () => void) => void,
  artifactSource?: string,
): Promise<SelectionFixture> => {
  const root = temporaryDirectory(onTestFinished, 'tau-selection-');
  await writeFileMap(root, packageFiles);

  const key = await readTauArtifactKey(root);
  const artifact = tauArtifactPath(root, key);

  if (artifactSource !== undefined) {
    await writeFileMap(root, { [artifact.slice(root.length + 1)]: artifactSource });
  }

  return { root, key, artifact };
};

const marker = (): unknown[] => {
  const globals = globalThis as { tauArtifactMarker?: unknown[] };

  globals.tauArtifactMarker ??= [];

  return globals.tauArtifactMarker;
};

const resetMarker = (): void => {
  marker().length = 0;
};

// The selector takes the source factory from its caller, so the test supplies its own instead of
// loading the registration owner and every extension it registers.
const sourceRegistration: TauRegistration = async () => {
  marker().push('source');
};

const loadSource = async () => sourceRegistration;

const artifactSource = `
export default async function register() {
  globalThis.tauArtifactMarker.push('registered');
}
`;

it('loads the artifact only when its key matches the current source inputs', async ({
  onTestFinished,
}) => {
  const { root, artifact } = await createFixture(onTestFinished, artifactSource);
  const { pi } = fakeExtensionApi();

  resetMarker();

  const registration = await resolveTauRegistration(root, loadSource);

  expect(registration).not.toBe(sourceRegistration);
  expect(marker()).toEqual([]);
  expect(artifact.endsWith('.mts')).toBe(true);

  await registration(pi);

  expect(marker()).toEqual(['registered']);
});

it('falls back to the source registration when no artifact matches', async ({ onTestFinished }) => {
  const { root } = await createFixture(onTestFinished);

  expect(await resolveTauRegistration(root, loadSource)).toBe(sourceRegistration);
});

it('falls back to the source registration when the inputs cannot be keyed', async ({
  onTestFinished,
}) => {
  const { root } = await createFixture(onTestFinished, artifactSource);

  await rm(join(root, 'tsconfig.json'));

  expect(await resolveTauRegistration(root, loadSource)).toBe(sourceRegistration);
});

it('keeps an artifact for an earlier key unused', async ({ onTestFinished }) => {
  const { root } = await createFixture(onTestFinished, artifactSource);

  await writeFile(join(root, 'src', 'tau', 'other.ts'), 'export default 2;\n');

  expect(await resolveTauRegistration(root, loadSource)).toBe(sourceRegistration);
});

it('reports an import error from a matching artifact without falling back to source', async ({
  onTestFinished,
}) => {
  const { root } = await createFixture(onTestFinished, 'export default ;\n');

  await expect(resolveTauRegistration(root, loadSource)).rejects.toThrow(/\S/u);
});

it('reports an initialization error from a matching artifact without running source', async ({
  onTestFinished,
}) => {
  const { root } = await createFixture(
    onTestFinished,
    "export default async function register() { throw new Error('artifact failed'); }\n",
  );

  const { pi } = fakeExtensionApi();

  resetMarker();

  const registration = await resolveTauRegistration(root, loadSource);

  expect(registration).not.toBe(sourceRegistration);
  await expect(registration(pi)).rejects.toThrow('artifact failed');
  expect(marker()).toEqual([]);
});

it('reports an artifact module without a default export', async ({ onTestFinished }) => {
  const { root } = await createFixture(onTestFinished, 'export const value = 1;\n');

  await expect(resolveTauRegistration(root, loadSource)).rejects.toThrow(
    /no default registration/u,
  );
});

it('accepts only an object with a function default as a registration module', () => {
  expect(isTauRegistrationModule(null)).toBe(false);
  expect(isTauRegistrationModule(1)).toBe(false);
  expect(isTauRegistrationModule({})).toBe(false);
  expect(isTauRegistrationModule({ default: 1 })).toBe(false);
  expect(isTauRegistrationModule({ default: async () => undefined })).toBe(true);
});

it('reports an artifact whose default export is not a registration', async ({ onTestFinished }) => {
  const { root } = await createFixture(onTestFinished, 'export default 1;\n');

  await expect(resolveTauRegistration(root, loadSource)).rejects.toThrow(
    /no default registration/u,
  );
});

it('reports an initialization error through the entry wrapper without running source', async ({
  onTestFinished,
}) => {
  const { root } = await createFixture(
    onTestFinished,
    "export default async function register() { throw new Error('artifact failed'); }\n",
  );

  const { pi } = fakeExtensionApi();

  resetMarker();

  await expect(loadTauRegistration(pi, root, loadSource)).rejects.toThrow('artifact failed');
  expect(marker()).toEqual([]);
});
