import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultResourceLoader, SettingsManager } from '@mariozechner/pi-coding-agent';
import { expect, it } from 'vitest';

it('rejects invalid instructions and reads them again on reload', async ({ onTestFinished }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-writing-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const extensionPath = join(cwd, 'index.ts');
  const instructionsPath = join(cwd, 'instructions.md');
  await copyFile(new URL('./index.ts', import.meta.url), extensionPath);
  await writeFile(instructionsPath, ' \n\t');

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, 'agent'),
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const { extensions, errors } = loader.getExtensions();
  expect(errors).toHaveLength(1);
  expect(errors[0]?.error).toContain(instructionsPath);
  expect(errors[0]?.error).toContain('empty');
  expect(extensions).toEqual([]);

  await writeFile(instructionsPath, '# Updated writing rules\n');
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions).toHaveLength(1);

  await rm(instructionsPath);
  await loader.reload();
  expect(loader.getExtensions().errors).toHaveLength(1);
  expect(loader.getExtensions().errors[0]?.error).toContain(instructionsPath);
  expect(loader.getExtensions().extensions).toEqual([]);
});
