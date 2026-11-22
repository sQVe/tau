import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { registerInstructions } from '../src/extensions/instructions.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface InstructionFixture {
  instructionsDirectory: string;
  loader: DefaultResourceLoader;
}

const fileInstructionSets = ['writing', 'workflow'] as const;

type FileInstructionSet = (typeof fileInstructionSets)[number];

const blankInstructions = ' \n\t';

const loadInstructionFixture = async (
  directory: string,
  blankInstructionSet?: FileInstructionSet,
): Promise<InstructionFixture> => {
  const instructionsDirectory = join(directory, 'instructions');

  await mkdir(instructionsDirectory);

  for (const instructionSet of fileInstructionSets) {
    const text =
      instructionSet === blankInstructionSet ? blankInstructions : `# ${instructionSet}\n`;

    await writeFile(join(instructionsDirectory, `${instructionSet}.md`), text);
  }

  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, 'agent'),
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [(pi) => registerInstructions(pi, instructionsDirectory)],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });

  await loader.reload();

  return { instructionsDirectory, loader };
};

for (const instructionSet of fileInstructionSets) {
  it(`rejects invalid ${instructionSet} instructions and reads them again on reload`, async ({
    onTestFinished,
  }) => {
    const directory = temporaryDirectory(onTestFinished, `tau-${instructionSet}-`);

    const { instructionsDirectory, loader } = await loadInstructionFixture(
      directory,
      instructionSet,
    );

    const instructionsPath = join(instructionsDirectory, `${instructionSet}.md`);

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
    const directory = temporaryDirectory(onTestFinished, 'tau-instructions-role-');
    const { loader } = await loadInstructionFixture(directory);

    const { extensions, errors } = loader.getExtensions();

    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(1);
    expect(extensions[0]?.handlers.has('before_agent_start') ?? false).toBe(appendsInstructions);
  },
);
