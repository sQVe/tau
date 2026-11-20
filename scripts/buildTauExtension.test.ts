import { existsSync } from 'node:fs';
import { readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import { readTauArtifactKey, tauArtifactPath } from '../src/tau/tauArtifact.js';
import { isTauRegistrationModule } from '../src/tau/tauSelection.js';
import { fakeExtensionApi } from '../tests/extensionApi.js';
import { writeFileMap } from '../tests/fileMap.js';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.js';
import { buildTauExtension, writeTauArtifact } from './buildTauExtension.js';

const packageFiles: Readonly<Record<string, string>> = {
  'package.json': '{"name":"tau-fixture","type":"module"}\n',
  'tsconfig.json': '{}\n',
  'scripts/buildTauExtension.ts': 'export const build = 1;\n',
};

const defaultSources: Readonly<Record<string, string>> = {
  'src/tau/tau.ts': [
    "import { dataUrl } from '../data.js';",
    '',
    'export default async function register(): Promise<void> {',
    '  throw new Error(dataUrl);',
    '}',
    '',
  ].join('\n'),
  'src/data.ts': "export const dataUrl = new URL('./data.json', import.meta.url).href;\n",
  'src/data.json': '{"value":1}\n',
};

const createFixture = async (
  onTestFinished: (cleanup: () => void) => void,
  sources: Readonly<Record<string, string>> = defaultSources,
): Promise<string> => {
  const root = temporaryDirectory(onTestFinished, 'tau-build-');
  await writeFileMap(root, { ...packageFiles, ...sources });

  return root;
};

const artifactFiles = async (root: string): Promise<string[]> => {
  try {
    return await readdir(join(root, 'dist', 'tau'));
  } catch {
    return [];
  }
};

it('builds one artifact for the current inputs and rebases source module URLs', async ({
  onTestFinished,
}) => {
  const root = await createFixture(onTestFinished);
  const key = await readTauArtifactKey(root);

  const target = await buildTauExtension(root);

  expect(target).toBe(tauArtifactPath(root, key));
  expect(await artifactFiles(root)).toEqual([`${key}.mts`]);

  const built: unknown = await import(pathToFileURL(target).href);

  if (!isTauRegistrationModule(built)) {
    throw new TypeError('The Tau artifact has no default registration.');
  }

  const expected = pathToFileURL(join(root, 'src', 'data.json')).href;

  await expect(built.default(fakeExtensionApi().pi)).rejects.toThrow(expected);
});

it('reuses an existing artifact for the same key', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished);
  const target = await buildTauExtension(root);

  await writeFile(target, 'existing artifact\n');

  expect(await buildTauExtension(root)).toBe(target);
  expect(await readFile(target, 'utf8')).toBe('existing artifact\n');
});

it('publishes nothing when the bundle fails', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': "import './missing.js';\n\nexport default async function register() {}\n",
  });

  await expect(buildTauExtension(root)).rejects.toThrow(/missing\.js/u);

  expect(await artifactFiles(root)).toEqual([]);
});

it('publishes nothing when the inputs change during the build', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished);
  const key = await readTauArtifactKey(root);

  await writeFile(join(root, 'src', 'data.json'), '{"value":2}\n');

  await expect(writeTauArtifact(root, key, 'built code\n')).rejects.toThrow(/changed/u);
  expect(await artifactFiles(root)).toEqual([]);
});

it('refuses an import.meta form that it cannot rebase', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts':
      "import { here } from '../data.js';\n\nexport default async function register() {\n  return here;\n}\n",
    'src/data.ts': 'export const here = import.meta.dirname;\n',
  });

  await expect(buildTauExtension(root)).rejects.toThrow(/import\.meta/u);

  expect(existsSync(join(root, 'dist', 'tau'))).toBe(false);
});

it('refuses a module whose suffix is outside the artifact key', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../legacy.cjs';",
      '',
      'export default async function register(): Promise<number> {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/legacy.cjs': 'module.exports = { value: 1 };\n',
  });

  await expect(buildTauExtension(root)).rejects.toThrow(/legacy\.cjs/u);

  expect(await artifactFiles(root)).toEqual([]);
});

it('refuses an unkeyed module instead of reusing an artifact for the same key', async ({
  onTestFinished,
}) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../legacy.cjs';",
      '',
      'export default async function register(): Promise<number> {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/legacy.cjs': 'module.exports = { value: 1 };\n',
  });

  // An older build published an artifact at this key, because the key never covered the module.
  const key = await readTauArtifactKey(root);
  const stale = await writeTauArtifact(root, key, 'stale code\n');

  await expect(buildTauExtension(root)).rejects.toThrow(/legacy\.cjs/u);
  expect(await readFile(stale, 'utf8')).toBe('stale code\n');
});

it('refuses an extensionless import that resolves to an unkeyed file', async ({
  onTestFinished,
}) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../value';",
      '',
      'export default async function register(): Promise<number> {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/value.tsx': 'export const value = 1;\n',
  });

  // An older build published an artifact at this key, because the key never covered the module.
  const key = await readTauArtifactKey(root);
  const stale = await writeTauArtifact(root, key, 'stale code\n');

  await expect(buildTauExtension(root)).rejects.toThrow(/value\.tsx/u);
  expect(await readFile(stale, 'utf8')).toBe('stale code\n');
});

it('builds a directory import that resolves to a keyed index file', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../value';",
      '',
      'export default async function register(): Promise<void> {',
      '  throw new Error(String(value));',
      '}',
      '',
    ].join('\n'),
    'src/value/index.js': 'export const value = 2;\n',
  });

  const target = await buildTauExtension(root);
  const module: unknown = await import(pathToFileURL(target).href);

  if (!isTauRegistrationModule(module)) {
    throw new Error('The Tau artifact has no default registration.');
  }

  await expect(module.default(fakeExtensionApi().pi)).rejects.toThrow('2');
});

it('refuses a directory import that a nested manifest would redirect', async ({
  onTestFinished,
}) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../nested';",
      '',
      'export default async function register(): Promise<number> {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/nested/index.js': 'export const value = 1;\n',
  });

  const target = await buildTauExtension(root);
  const built = await readFile(target, 'utf8');

  // The older publisher excluded nested packages from the key, so this tree kept its key.
  await writeFileMap(root, { 'src/nested/package.json': '{"main":"../one.js"}\n' });

  await expect(buildTauExtension(root)).rejects.toThrow(/nested package/u);
  expect(await readFile(target, 'utf8')).toBe(built);
});

it('refuses a module of a nested package that imports through its manifest', async ({
  onTestFinished,
}) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../nested/b.js';",
      '',
      'export default async function register(): Promise<number> {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/nested/package.json': '{"imports":{"#value":"./c.js"}}\n',
    'src/nested/b.ts': "import { value } from '#value';\n\nexport { value };\n",
    'src/nested/c.js': 'export const value = 1;\n',
  });

  await expect(buildTauExtension(root)).rejects.toThrow(/nested package/u);

  expect(await artifactFiles(root)).toEqual([]);
});

it('refuses a nested tsconfig below the source root', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, { 'src/tau/tsconfig.json': '{}\n' });

  await expect(buildTauExtension(root)).rejects.toThrow(/tsconfig\.json below the root/u);

  expect(await artifactFiles(root)).toEqual([]);
});

it('refuses a source root that is a symbolic link', async ({ onTestFinished }) => {
  const root = temporaryDirectory(onTestFinished, 'tau-build-');

  await writeFileMap(root, {
    'package.json': '{"name":"tau-fixture","type":"module"}\n',
    'tsconfig.json': '{}\n',
    'scripts/buildTauExtension.ts': 'export const build = 1;\n',
    'elsewhere/tau/tau.ts': 'export default async function register() {}\n',
  });

  await symlink(join(root, 'elsewhere'), join(root, 'src'));

  await expect(buildTauExtension(root)).rejects.toThrow(/src is a symbolic link/u);

  expect(await artifactFiles(root)).toEqual([]);
});

it('refuses a module outside src that the bundle reads', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../../outside.js';",
      '',
      'export default async function register(): Promise<number> {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'outside.js': 'export const value = 1;\n',
  });

  await expect(buildTauExtension(root)).rejects.toThrow(/outside\.js/u);

  expect(await artifactFiles(root)).toEqual([]);
});

it('refuses a linked module whose link-path manifest changes the side effects', async ({
  onTestFinished,
}) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../../config-alias/value.js';",
      '',
      'export default async function register(): Promise<string> {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/value.js':
      "globalThis.tauSideEffect = 'side-effect-marker';\nexport const value = 'value';\n",
  });

  await writeFileMap(root, { 'config-alias/package.json': '{"sideEffects":false}\n' });
  await symlink(join(root, 'src', 'value.js'), join(root, 'config-alias', 'value.js'));

  // The key covers the real path but not the link path or the manifest beside it.
  const key = await readTauArtifactKey(root);
  const stale = await writeTauArtifact(root, key, 'stale code\n');

  await expect(buildTauExtension(root)).rejects.toThrow(/config-alias\/value\.js/u);
  expect(await readFile(stale, 'utf8')).toBe('stale code\n');
});

it('refuses an unkeyed re-export that tree shaking removes', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import { value } from '../../outside.js';",
      '',
      'export default async function register(): Promise<string> {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'outside.js': "export { value } from './src/one.js';\n",
    'src/one.js': "export const value = 'FIRST';\n",
    'src/two.js': "export const value = 'SECOND';\n",
  });

  // The key covers both targets but not the selector outside src/.
  const key = await readTauArtifactKey(root);
  const stale = await writeTauArtifact(root, key, 'stale code\n');

  await expect(buildTauExtension(root)).rejects.toThrow(/outside\.js/u);
  expect(await readFile(stale, 'utf8')).toBe('stale code\n');
});

it('refuses a TypeScript project reference the key does not cover', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'tsconfig.json': '{"files":[],"references":[{"path":"./config/base.json"}]}\n',
    'config/base.json':
      '{"compilerOptions":{"composite":true,"verbatimModuleSyntax":false},"include":["../src/**/*"]}\n',
    'src/tau/tau.ts': [
      "import { Thing } from '../value.js';",
      '',
      'export default async function register(): Promise<Thing | undefined> {',
      '  return undefined;',
      '}',
      '',
    ].join('\n'),
    'src/value.ts': "console.log('retained side effect');\nexport class Thing {}\n",
  });

  await expect(buildTauExtension(root)).rejects.toThrow(/config\/base\.json/u);

  expect(await artifactFiles(root)).toEqual([]);
});

it('builds with the keyed root manifest imported as a JSON module', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import manifest from '../../package.json' with { type: 'json' };",
      '',
      'export default async function register(): Promise<string> {',
      "  return manifest['name'];",
      '}',
      '',
    ].join('\n'),
  });

  const target = await buildTauExtension(root);
  const module: unknown = await import(pathToFileURL(target).href);

  if (!isTauRegistrationModule(module)) {
    throw new Error('The Tau artifact has no default registration.');
  }

  await expect(module.default(fakeExtensionApi().pi)).resolves.toBe('tau-fixture');
});

it('builds with an inherited config imported as a JSON module', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'tsconfig.json': '{"extends":"./tsconfig.base.json"}\n',
    'tsconfig.base.json': '{"compilerOptions":{"verbatimModuleSyntax":false}}\n',
    'src/tau/tau.ts': [
      "import config from '../../tsconfig.base.json' with { type: 'json' };",
      '',
      'export default async function register(): Promise<boolean> {',
      "  return config['compilerOptions']['verbatimModuleSyntax'];",
      '}',
      '',
    ].join('\n'),
  });

  const target = await buildTauExtension(root);
  const module: unknown = await import(pathToFileURL(target).href);

  if (!isTauRegistrationModule(module)) {
    throw new Error('The Tau artifact has no default registration.');
  }

  await expect(module.default(fakeExtensionApi().pi)).resolves.toBe(false);
});

it('keys every file in the tsconfig extends chain', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'tsconfig.json':
      '{\n  // A comment is valid in a tsconfig.\n  "extends": "./tsconfig.base.json",\n}\n',
    'tsconfig.base.json': '{"compilerOptions":{"verbatimModuleSyntax":false}}\n',
    'src/tau/tau.ts': [
      "import { Thing } from '../value.js';",
      '',
      'export default async function register(): Promise<Thing | undefined> {',
      '  return undefined;',
      '}',
      '',
    ].join('\n'),
    'src/value.ts': "console.log('retained side effect');\nexport class Thing {}\n",
  });

  const before = await buildTauExtension(root);

  await writeFile(
    join(root, 'tsconfig.base.json'),
    '{"compilerOptions":{"verbatimModuleSyntax":true}}\n',
  );

  const after = await buildTauExtension(root);

  expect(after).not.toBe(before);
  expect(await readFile(after, 'utf8')).not.toBe(await readFile(before, 'utf8'));
});

it('refuses a tsconfig extends chain outside the package', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"@tsconfig/node20/tsconfig.json"}\n',
  });

  await expect(buildTauExtension(root)).rejects.toThrow(/extends/u);

  expect(await artifactFiles(root)).toEqual([]);
});

it('bundles a keyed JSON module whose text mentions import.meta', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      "import data from '../data.json' with { type: 'json' };",
      '',
      'export default async function register(): Promise<string> {',
      "  return data['import.meta'];",
      '}',
      '',
    ].join('\n'),
    'src/data.json': '{"import.meta":"kept as data"}\n',
  });

  const target = await buildTauExtension(root);
  const module: unknown = await import(pathToFileURL(target).href);

  if (!isTauRegistrationModule(module)) {
    throw new Error('The Tau artifact has no default registration.');
  }

  await expect(module.default(fakeExtensionApi().pi)).resolves.toBe('kept as data');
});

it('inlines a literal dynamic import and keeps it deferred', async ({ onTestFinished }) => {
  const root = await createFixture(onTestFinished, {
    'src/tau/tau.ts': [
      'export default async function register(): Promise<string> {',
      "  const { value } = await import('../value.js');",
      '',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/value.ts': "globalThis.tauDynamicValue = 'loaded';\nexport const value = 'loaded';\n",
  });

  const target = await buildTauExtension(root);
  const module: unknown = await import(pathToFileURL(target).href);

  if (!isTauRegistrationModule(module)) {
    throw new Error('The Tau artifact has no default registration.');
  }

  const globals = globalThis as { tauDynamicValue?: string };

  expect(globals.tauDynamicValue).toBeUndefined();
  await expect(module.default(fakeExtensionApi().pi)).resolves.toBe('loaded');
  expect(globals.tauDynamicValue).toBe('loaded');

  Reflect.deleteProperty(globals, 'tauDynamicValue');
});
