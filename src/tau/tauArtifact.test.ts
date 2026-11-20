import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { writeFileMap } from '../../tests/fileMap.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { readTauArtifactInputs, readTauArtifactKey, tauArtifactPath } from './tauArtifact.js';

const packageFiles: Readonly<Record<string, string>> = {
  'package.json': '{"name":"tau-fixture"}\n',
  'tsconfig.json': '{}\n',
  'scripts/buildTauExtension.ts': 'export const build = 1;\n',
};

const defaultSources: Readonly<Record<string, string>> = {
  'src/tau/tau.ts': 'export default 1;\n',
};

const createPackageRoot = async (
  onTestFinished: (cleanup: () => void) => void,
  sources: Readonly<Record<string, string>> = defaultSources,
): Promise<string> => {
  const root = temporaryDirectory(onTestFinished, 'tau-artifact-');
  await writeFileMap(root, { ...packageFiles, ...sources });

  return root;
};

it('changes the key when a source byte changes without changing the file size', async ({
  onTestFinished,
}) => {
  const root = await createPackageRoot(onTestFinished, {
    'src/value.ts': 'export const value = 1;\n',
  });

  const before = await readTauArtifactKey(root);

  await writeFile(join(root, 'src', 'value.ts'), 'export const value = 2;\n');

  expect(await readTauArtifactKey(root)).not.toBe(before);
});

it('changes the key when a source file is added', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished);
  const before = await readTauArtifactKey(root);

  await writeFile(join(root, 'src', 'added.ts'), 'export const added = true;\n');

  expect(await readTauArtifactKey(root)).not.toBe(before);
});

it('ignores source files that the bundle cannot import', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    'src/notes.md': '# First\n',
    'src/data.txt': 'first\n',
  });

  const before = await readTauArtifactKey(root);

  await writeFile(join(root, 'src', 'notes.md'), '# Second\n');
  await writeFile(join(root, 'src', 'data.txt'), 'second\n');

  expect(await readTauArtifactKey(root)).toBe(before);
});

it('keys the manifest, the TypeScript config, and the build script', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished);
  const initial = await readTauArtifactKey(root);

  for (const name of Object.keys(packageFiles)) {
    await writeFile(join(root, name), '{"changed":true}\n');

    const changed = await readTauArtifactKey(root);

    expect(changed, name).not.toBe(initial);

    await writeFile(join(root, name), packageFiles[name] ?? '');
  }
});

it('keys every file in the TypeScript config extends chain', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': [
      '{',
      '  // A line comment holds a quote " and a closing brace }.',
      '  "extends": "./tsconfig.base.json", /* A block comment. */',
      '  "compilerOptions": { "lib": ["ES2024",], "outDir": "a\\"b,}/" },',
      '}',
      '',
    ].join('\n'),
    'tsconfig.base.json': '{"compilerOptions":{"verbatimModuleSyntax":false}}\n',
  });

  const before = await readTauArtifactKey(root);

  await writeFile(
    join(root, 'tsconfig.base.json'),
    '{"compilerOptions":{"verbatimModuleSyntax":true}}\n',
  );

  expect(await readTauArtifactKey(root)).not.toBe(before);
});

it('keeps a string that holds a comment marker or a closing brace', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"./tsconfig.base.json","compilerOptions":{"outDir":"a//b,}"}}\n',
    'tsconfig.base.json': '{"compilerOptions":{"verbatimModuleSyntax":false}}\n',
  });

  const before = await readTauArtifactKey(root);

  await writeFile(
    join(root, 'tsconfig.base.json'),
    '{"compilerOptions":{"verbatimModuleSyntax":true}}\n',
  );

  expect(await readTauArtifactKey(root)).not.toBe(before);
});

it('keys a chain of extended TypeScript configs', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"./config/a.json"}\n',
    'config/a.json': '{"extends":"./b.json"}\n',
    'config/b.json': '{"compilerOptions":{"verbatimModuleSyntax":false}}\n',
  });

  const before = await readTauArtifactKey(root);

  await writeFile(
    join(root, 'config', 'b.json'),
    '{"compilerOptions":{"verbatimModuleSyntax":true}}\n',
  );

  expect(await readTauArtifactKey(root)).not.toBe(before);
});

it('keys a TypeScript config that extends back to itself', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"./tsconfig.base.json"}\n',
    'tsconfig.base.json': '{"extends":"./tsconfig.json","compilerOptions":{}}\n',
  });

  const before = await readTauArtifactKey(root);

  await writeFile(
    join(root, 'tsconfig.base.json'),
    '{"extends":"./tsconfig.json","compilerOptions":{"verbatimModuleSyntax":true}}\n',
  );

  expect(await readTauArtifactKey(root)).not.toBe(before);
});

it('refuses a TypeScript config that extends a missing file', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"./missing.json"}\n',
  });

  await expect(readTauArtifactKey(root)).rejects.toThrow(/missing/u);
});

it('refuses a TypeScript config that extends a file outside the package', async ({
  onTestFinished,
}) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"../outside.json"}\n',
  });

  await expect(readTauArtifactKey(root)).rejects.toThrow(/outside the package/u);
});

it('refuses a TypeScript config that is not JSON', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":}\n',
  });

  await expect(readTauArtifactKey(root)).rejects.toThrow(/Cannot read tsconfig\.json/u);
});

it('refuses a TypeScript config that is not an object', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '[]\n',
  });

  await expect(readTauArtifactKey(root)).rejects.toThrow(/JSON object/u);
});

it('refuses a TypeScript config whose extends target is not a path', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":1}\n',
  });

  await expect(readTauArtifactKey(root)).rejects.toThrow(/not a path/u);
});

it('refuses a TypeScript config that extends a package', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"@tsconfig/node20/tsconfig.json"}\n',
  });

  await expect(readTauArtifactKey(root)).rejects.toThrow(/outside the package/u);
});

it('refuses to key a package without its build inputs', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished);

  await rm(join(root, 'tsconfig.json'));

  await expect(readTauArtifactKey(root)).rejects.toThrow(/tsconfig\.json/u);
});

it('refuses to key a source tree that holds a symbolic link', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    'src/value.ts': 'export const value = 1;\n',
  });

  await symlink(join(root, 'src', 'value.ts'), join(root, 'src', 'linked.ts'));

  await expect(readTauArtifactKey(root)).rejects.toThrow(/symbolic link/u);
});

it('refuses a symbolic link inside a directory that holds its own manifest', async ({
  onTestFinished,
}) => {
  const root = await createPackageRoot(onTestFinished, {
    'src/nested/package.json': '{}\n',
    'src/nested/value.ts': 'export const value = 1;\n',
  });

  await symlink(join(root, 'src', 'nested', 'value.ts'), join(root, 'src', 'nested', 'linked.ts'));

  await expect(readTauArtifactKey(root)).rejects.toThrow(/symbolic link/u);
});

it('refuses a directory under src that holds its own package.json', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    'src/nested/package.json': '{}\n',
    'src/nested/value.ts': 'export const value = 1;\n',
  });

  await expect(readTauArtifactKey(root)).rejects.toThrow(/holds its own package\.json/u);
});

it('refuses a tsconfig.json below the root', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    'src/tau/tsconfig.json': '{}\n',
  });

  await expect(readTauArtifactKey(root)).rejects.toThrow(/tsconfig\.json below the root/u);
});

it('refuses a TypeScript config that is a symlink outside the package', async ({
  onTestFinished,
}) => {
  const outside = temporaryDirectory(onTestFinished, 'tau-outside-');

  await writeFile(join(outside, 'base.json'), '{"compilerOptions":{}}\n');

  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"./tsconfig.base.json"}\n',
  });

  await symlink(join(outside, 'base.json'), join(root, 'tsconfig.base.json'));

  await expect(readTauArtifactKey(root)).rejects.toThrow(/outside the package/u);
});

it('keys a TypeScript config with a byte order mark', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '\uFEFF{"extends":"./tsconfig.base.json"}\n',
    'tsconfig.base.json': '{"compilerOptions":{"verbatimModuleSyntax":false}}\n',
  });

  const before = await readTauArtifactKey(root);

  await writeFile(
    join(root, 'tsconfig.base.json'),
    '{"compilerOptions":{"verbatimModuleSyntax":true}}\n',
  );

  expect(await readTauArtifactKey(root)).not.toBe(before);
});

it('keys an extends target whose name starts with two dots', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'tsconfig.json': '{"extends":"./..base.json"}\n',
    '..base.json': '{"compilerOptions":{"verbatimModuleSyntax":false}}\n',
  });

  const before = await readTauArtifactKey(root);

  await writeFile(join(root, '..base.json'), '{"compilerOptions":{"verbatimModuleSyntax":true}}\n');

  expect(await readTauArtifactKey(root)).not.toBe(before);
});

it('returns the full keyed inventory with the key', async ({ onTestFinished }) => {
  const root = await createPackageRoot(onTestFinished, {
    ...defaultSources,
    'src/value.ts': 'export const value = 1;\n',
    'src/notes.md': '# Notes\n',
  });

  const { key, inputPaths } = await readTauArtifactInputs(root);

  expect(key).toBe(await readTauArtifactKey(root));

  expect(inputPaths).toEqual([
    join(root, 'package.json'),
    join(root, 'scripts', 'buildTauExtension.ts'),
    join(root, 'src', 'tau', 'tau.ts'),
    join(root, 'src', 'value.ts'),
    join(root, 'tsconfig.json'),
  ]);
});

it('refuses a source root that is a symbolic link', async ({ onTestFinished }) => {
  const root = temporaryDirectory(onTestFinished, 'tau-artifact-');

  await writeFileMap(root, {
    'package.json': '{"name":"tau-fixture"}\n',
    'tsconfig.json': '{}\n',
    'scripts/buildTauExtension.ts': 'export const build = 1;\n',
    'elsewhere/tau/tau.ts': 'export default 1;\n',
  });

  await symlink(join(root, 'elsewhere'), join(root, 'src'));

  await expect(readTauArtifactKey(root)).rejects.toThrow(/src is a symbolic link/u);
});

it('names the artifact after the exact key below dist/tau', () => {
  const key = 'ab'.repeat(32);

  expect(tauArtifactPath('/package', key)).toBe(join('/package', 'dist', 'tau', `${key}.mts`));
});

it('refuses an artifact key that is not a content digest', () => {
  expect(() => tauArtifactPath('/package', '../../escape')).toThrow(/SHA-256/u);
  expect(() => tauArtifactPath('/package', 'ab')).toThrow(/SHA-256/u);
});
