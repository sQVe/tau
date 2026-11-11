import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const instructionSets = ['writing', 'coding', 'workflow'] as const;

const copiedFiles = [
  'extensions/instructions.ts',
  'instructions/instructions.ts',
  'instructions/systemPrompt.ts',
  'instructions/typescript.md',
  'instructions/typescriptRules.ts',
  'instructions/typescriptRulesDecision.ts',
  'schema.ts',
  'worker.ts',
];

for (const instructionSet of instructionSets) {
  it(`rejects invalid ${instructionSet} instructions and reads them again on reload`, async ({
    onTestFinished,
  }) => {
    const workingDirectory = temporaryDirectory(onTestFinished, `tau-${instructionSet}-`);

    // Keep the extension's relative imports and the instruction files' path.
    const extensionPath = join(workingDirectory, 'extensions', 'instructions.ts');
    const instructionsPath = join(workingDirectory, 'instructions', `${instructionSet}.md`);

    await mkdir(join(workingDirectory, 'extensions'));
    await mkdir(join(workingDirectory, 'instructions'));

    for (const copiedFile of copiedFiles) {
      await copyFile(
        new URL(`../src/${copiedFile}`, import.meta.url),
        join(workingDirectory, copiedFile),
      );
    }

    for (const otherSet of instructionSets) {
      await writeFile(join(workingDirectory, 'instructions', `${otherSet}.md`), `# ${otherSet}\n`);
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

    await writeFile(instructionsPath, `# Updated ${instructionSet} rules\n`);
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

it.for([
  { role: 'worker', appendsInstructions: false },
  { role: undefined, appendsInstructions: true },
])(
  'appends instruction sets only in a non-worker session with TAU_ROLE $role',
  async ({ role, appendsInstructions }, { onTestFinished }) => {
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    vi.stubEnv('TAU_ROLE', role);
    vi.stubEnv('TAU_WORKER_RECORD', undefined);
    const workingDirectory = temporaryDirectory(onTestFinished, 'tau-instructions-role-');
    const extensionPath = join(workingDirectory, 'extensions', 'instructions.ts');

    await mkdir(join(workingDirectory, 'extensions'));
    await mkdir(join(workingDirectory, 'instructions'));

    for (const copiedFile of copiedFiles) {
      await copyFile(
        new URL(`../src/${copiedFile}`, import.meta.url),
        join(workingDirectory, copiedFile),
      );
    }

    for (const instructionSet of instructionSets) {
      await writeFile(
        join(workingDirectory, 'instructions', `${instructionSet}.md`),
        `# ${instructionSet}\n`,
      );
    }

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

    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(1);
    expect(extensions[0]?.handlers.has('before_agent_start') ?? false).toBe(appendsInstructions);
  },
);
