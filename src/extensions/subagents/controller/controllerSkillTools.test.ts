import { readFileSync, readdirSync } from 'node:fs';
import type * as FileSystem from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it, onTestFinished, vi } from 'vitest';

import { setup } from './fixtures/controllerFixture.js';

vi.mock(import('node:fs'), { spy: true });

const skillToolsPath = fileURLToPath(new URL('../../../skillTools.ts', import.meta.url));

it('refuses a launch when skillTools changed on disk since the parent loaded it', async () => {
  const fixture = setup(onTestFinished);
  const actualFileSystem = await vi.importActual<typeof FileSystem>('node:fs');
  const readActual = actualFileSystem.readFileSync as (...values: unknown[]) => unknown;

  onTestFinished(() => {
    vi.mocked(readFileSync).mockReset();
  });

  vi.mocked(readFileSync).mockImplementation(((path: string, ...rest: unknown[]) =>
    path === skillToolsPath
      ? "export const skillTools = { tdd: ['full_check', 'mutation_check'] };\n"
      : readActual(path, ...rest)) as typeof readFileSync);

  const recordsBefore = readdirSync(fixture.directory);

  const launchResult = await fixture.controller
    .launch(fixture.input)
    .catch((error: unknown) => error);

  expect(launchResult).toBeInstanceOf(Error);
  expect(String(launchResult)).toContain('/reload');
  expect(readdirSync(fixture.directory)).toEqual(recordsBefore);
  expect(fixture.calls).toEqual([]);
});

it('launches when skillTools on disk matches the parent copy', async () => {
  const fixture = setup(onTestFinished);

  const status = await fixture.controller.launch(fixture.input);

  expect(status.state).not.toBe('stopped');
});
