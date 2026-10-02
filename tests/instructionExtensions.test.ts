import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

const instructionExtensions = ['writing', 'coding', 'workflow'] as const;
const sharedModules = ['instructionSets', 'systemPrompt', 'workerProcess'];

for (const extension of instructionExtensions) {
  it(`rejects invalid ${extension} instructions and reads them again on reload`, async ({
    onTestFinished,
  }) => {
    const workingDirectory = await mkdtemp(join(tmpdir(), `tau-${extension}-`));
    onTestFinished(() => rm(workingDirectory, { recursive: true, force: true }));

    // Keep the extension's relative imports of the shared modules and their instructions path.
    const extensionPath = join(workingDirectory, 'extensions', `${extension}.ts`);
    const instructionsPath = join(workingDirectory, 'instructions', `${extension}.md`);

    await mkdir(join(workingDirectory, 'extensions'));
    await mkdir(join(workingDirectory, 'instructions'));
    await copyFile(new URL(`../src/extensions/${extension}.ts`, import.meta.url), extensionPath);

    for (const sharedModule of sharedModules) {
      await copyFile(
        new URL(`../src/${sharedModule}.ts`, import.meta.url),
        join(workingDirectory, `${sharedModule}.ts`),
      );
    }

    await writeFile(instructionsPath, ' \n\t');

    const loader = new DefaultResourceLoader({
      cwd: workingDirectory,
      agentDir: join(workingDirectory, 'agent'),
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

    await writeFile(instructionsPath, `# Updated ${extension} rules\n`);
    await loader.reload();

    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);

    await rm(instructionsPath);
    await loader.reload();

    expect(loader.getExtensions().errors).toHaveLength(1);
    expect(loader.getExtensions().errors[0]?.error).toContain(instructionsPath);
    expect(loader.getExtensions().extensions).toEqual([]);
  });
}
