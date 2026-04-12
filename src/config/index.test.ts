import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigValidationError, loadConfig } from './index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'tau-config-'));
  tempDirs.push(root);
  return root;
};

const configPath = (root: string) => join(root, 'tau.config.json');

const writeConfigFile = async (root: string, content: string): Promise<void> => {
  const file = configPath(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
};

const expectValidationError = async (
  promise: Promise<unknown>,
  field: string | string[],
  reason: string | RegExp,
) => {
  const caught = await promise.then(
    () => {
      throw new Error('expected ConfigValidationError but promise resolved');
    },
    (error: unknown) => error,
  );

  expect(caught).toBeInstanceOf(ConfigValidationError);
  expect((caught as ConfigValidationError).field).toEqual(field);

  const actualReason = (caught as ConfigValidationError).reason;
  if (typeof reason === 'string') {
    expect(actualReason).toBe(reason);
  } else {
    expect(actualReason).toMatch(reason);
  }
};

describe('loadConfig', () => {
  describe('defaults and parsing', () => {
    it('returns TS+vitest defaults when tau.config.json is missing', async () => {
      const root = await createTempRoot();

      await expect(loadConfig(root)).resolves.toEqual({
        production: [join(root, 'src/**/*.{ts,tsx}').replaceAll('\\', '/')],
        tests: [
          join(root, '**/*.test.ts').replaceAll('\\', '/'),
          join(root, '**/*.spec.ts').replaceAll('\\', '/'),
        ],
      });
    });

    it('accepts an empty object and falls back to defaults', async () => {
      const root = await createTempRoot();
      await writeConfigFile(root, '{}');

      await expect(loadConfig(root)).resolves.toEqual({
        production: [join(root, 'src/**/*.{ts,tsx}').replaceAll('\\', '/')],
        tests: [
          join(root, '**/*.test.ts').replaceAll('\\', '/'),
          join(root, '**/*.spec.ts').replaceAll('\\', '/'),
        ],
      });
    });

    it('parses a valid tau.config.json and merges it over defaults', async () => {
      const root = await createTempRoot();
      await writeConfigFile(root, JSON.stringify({ tests: ['tests/**/*.ts'] }));

      await expect(loadConfig(root)).resolves.toEqual({
        production: [join(root, 'src/**/*.{ts,tsx}').replaceAll('\\', '/')],
        tests: [join(root, 'tests/**/*.ts').replaceAll('\\', '/')],
      });
    });
  });

  describe('validation', () => {
    it('surfaces invalid JSON with a clear ConfigValidationError', async () => {
      const root = await createTempRoot();
      await writeConfigFile(root, '{not-json');

      await expectValidationError(loadConfig(root), '<root>', /invalid JSON:/);
    });

    it('rejects a zero-byte tau.config.json as invalid JSON', async () => {
      const root = await createTempRoot();
      await writeConfigFile(root, '');

      await expectValidationError(loadConfig(root), '<root>', /invalid JSON:/);
    });

    it('rejects an empty production glob list with an actionable error', async () => {
      const root = await createTempRoot();
      await writeConfigFile(root, JSON.stringify({ production: [] }));

      await expectValidationError(loadConfig(root), 'production', 'must contain at least one glob');
    });

    it('rejects a root-glob in production with an actionable error', async () => {
      const root = await createTempRoot();
      await writeConfigFile(root, JSON.stringify({ production: ['./**/*'] }));

      await expectValidationError(loadConfig(root), 'production', 'root-glob **');
    });

    it('rejects overlap between tests and production globs with both fields named', async () => {
      const root = await createTempRoot();
      await writeConfigFile(
        root,
        JSON.stringify({
          production: ['src/**/*.test.ts'],
          tests: ['src/**/*.test.ts'],
        }),
      );

      await expectValidationError(loadConfig(root), ['tests', 'production'], /shared literal glob/);
    });

    it('rejects unknown top-level keys via the strict schema', async () => {
      const root = await createTempRoot();
      await writeConfigFile(root, JSON.stringify({ extra: true }));

      await expectValidationError(loadConfig(root), 'extra', /Unexpected property/);
    });

    it('rejects non-string array elements via the typebox schema', async () => {
      const root = await createTempRoot();
      await writeConfigFile(root, JSON.stringify({ production: [123] }));

      await expectValidationError(loadConfig(root), 'production.0', /Expected string/);
    });
  });

  describe('normalization and immutability', () => {
    it('normalizes relative globs against the provided rootDir', async () => {
      const root = await createTempRoot();
      await writeConfigFile(
        root,
        JSON.stringify({
          production: ['./lib/**/*.ts'],
          tests: ['./test/**/*.spec.ts'],
        }),
      );

      await expect(loadConfig(root)).resolves.toEqual({
        production: [join(root, 'lib/**/*.ts').replaceAll('\\', '/')],
        tests: [join(root, 'test/**/*.spec.ts').replaceAll('\\', '/')],
      });
    });

    it('accepts duplicate globs within a list and dedupes them silently', async () => {
      const root = await createTempRoot();
      await writeConfigFile(
        root,
        JSON.stringify({
          production: ['src/**/*.ts', 'src/**/*.ts'],
          tests: ['tests/**/*.ts', 'tests/**/*.ts'],
        }),
      );

      await expect(loadConfig(root)).resolves.toEqual({
        production: [join(root, 'src/**/*.ts').replaceAll('\\', '/')],
        tests: [join(root, 'tests/**/*.ts').replaceAll('\\', '/')],
      });
    });

    it('returns a deep copy so mutations do not affect subsequent loads', async () => {
      const root = await createTempRoot();

      const firstLoad = await loadConfig(root);
      firstLoad.production[0] = 'mutated';

      await expect(loadConfig(root)).resolves.toEqual({
        production: [join(root, 'src/**/*.{ts,tsx}').replaceAll('\\', '/')],
        tests: [
          join(root, '**/*.test.ts').replaceAll('\\', '/'),
          join(root, '**/*.spec.ts').replaceAll('\\', '/'),
        ],
      });
    });
  });

  describe('file system failures', () => {
    it('surfaces unreadable config path errors as-is', async () => {
      const root = await createTempRoot();
      await mkdir(configPath(root));

      await expect(loadConfig(root)).rejects.toMatchObject({ code: 'EISDIR' });
    });

    it.skipIf(process.getuid?.() === 0)(
      'surfaces unreadable file permission errors as-is',
      async () => {
        const root = await createTempRoot();
        await writeConfigFile(root, '{}');
        await chmod(configPath(root), 0o000);

        await expect(loadConfig(root)).rejects.toMatchObject({ code: 'EACCES' });
        await chmod(configPath(root), 0o600);
      },
    );
  });
});
