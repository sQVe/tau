import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

const instructionExtensions = ['writing', 'coding', 'workflow'] as const;

for (const extension of instructionExtensions) {
  it(`rejects invalid ${extension} instructions and reads them again on reload`, async ({
    onTestFinished,
  }) => {
    const workingDirectory = await mkdtemp(join(tmpdir(), `tau-${extension}-`));
    onTestFinished(() => rm(workingDirectory, { recursive: true, force: true }));

    // Keep the extension's relative import of the shared system prompt helper.
    const extensionDirectory = join(workingDirectory, 'extensions', extension);
    const extensionPath = join(extensionDirectory, 'index.ts');
    const instructionsPath = join(extensionDirectory, 'instructions.md');

    await mkdir(extensionDirectory, { recursive: true });
    await mkdir(join(workingDirectory, 'systemPrompt'));

    await copyFile(
      new URL(`../src/extensions/${extension}/index.ts`, import.meta.url),
      extensionPath,
    );

    await copyFile(
      new URL('../src/systemPrompt/index.ts', import.meta.url),
      join(workingDirectory, 'systemPrompt', 'index.ts'),
    );

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
