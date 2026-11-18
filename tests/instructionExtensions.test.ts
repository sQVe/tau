import { copyFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { codingSetText } from '../src/instructions/guideRuns.js';
import { resolveStommeGuides } from '../src/instructions/stommeGuides/stommeGuides.js';
import { bundleGuide, runWorker, startMainSession } from './guideSessionHarness.js';
import { writeStommeProject } from './stommeProjectHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const fileInstructionSets = ['writing', 'workflow'] as const;

const copiedFiles = [
  'errors.ts',
  'extensions/instructions.ts',
  'instructions/guideRuns.ts',
  'instructions/instructions.ts',
  'instructions/stommeGuides/stommeGuides.ts',
  'instructions/stommeGuides/stommeGuidesDecision.ts',
  'instructions/syncRecord.ts',
  'instructions/syncedGuides.ts',
  'instructions/systemPrompt.ts',
  'instructions/typescript.md',
  'instructions/typescriptRules.ts',
  'instructions/typescriptRulesDecision.ts',
  'schema.ts',
  'role/role.ts',
];

// Keeps the extension's relative imports, its package imports, and the instruction files' path.
const copySources = async (workingDirectory: string): Promise<void> => {
  await mkdir(join(workingDirectory, 'extensions'));
  await mkdir(join(workingDirectory, 'instructions', 'stommeGuides'), { recursive: true });

  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(workingDirectory, 'node_modules'),
  );

  for (const copiedFile of copiedFiles) {
    const destination = join(workingDirectory, copiedFile);

    await mkdir(dirname(destination), { recursive: true });
    await copyFile(new URL(`../src/${copiedFile}`, import.meta.url), destination);
  }
};

for (const instructionSet of fileInstructionSets) {
  it(`rejects invalid ${instructionSet} instructions and reads them again on reload`, async ({
    onTestFinished,
  }) => {
    const workingDirectory = temporaryDirectory(onTestFinished, `tau-${instructionSet}-`);

    const extensionPath = join(workingDirectory, 'extensions', 'instructions.ts');
    const instructionsPath = join(workingDirectory, 'instructions', `${instructionSet}.md`);

    await copySources(workingDirectory);

    for (const otherSet of fileInstructionSets) {
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

    await copySources(workingDirectory);

    for (const instructionSet of fileInstructionSets) {
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

it('main session and worker load the same stomme guides', async ({ onTestFinished }) => {
  const project = temporaryDirectory(onTestFinished, 'tau-guides-project-');

  await writeStommeProject(project, { language: 'typescript' });

  const snapshot = await resolveStommeGuides(project);
  const main = await startMainSession(onTestFinished, project);
  const mainPrompt = await main.run();
  const worker = await runWorker(onTestFinished, project, ['writing', 'coding', 'workflow']);
  const again = await resolveStommeGuides(project);

  expect(snapshot.kind).toBe('project');
  expect(again).toEqual(snapshot);
  expect(mainPrompt.split(codingSetText(snapshot))).toHaveLength(2);
  expect(worker.notices).toEqual([]);
  expect(worker.prompt.split(codingSetText(snapshot))).toHaveLength(2);
});

it('loads a selected layer guide', async ({ onTestFinished }) => {
  const gpuiGuide = await bundleGuide('layers/gpui/guide.md');
  const selected = temporaryDirectory(onTestFinished, 'tau-guides-selected-');
  const recorded = temporaryDirectory(onTestFinished, 'tau-guides-recorded-');

  await writeStommeProject(selected, { language: 'rust', layers: ['gpui'] });
  await writeStommeProject(recorded, { language: 'rust', recordedLayers: ['gpui'] });

  const selectedPrompt = await (await startMainSession(onTestFinished, selected)).run();
  const recordedPrompt = await (await startMainSession(onTestFinished, recorded)).run();

  expect(selectedPrompt).toContain(gpuiGuide);
  expect(recordedPrompt).not.toContain(gpuiGuide);
});

it('loads a layer added during a session at the next run', async ({ onTestFinished }) => {
  const gpuiGuide = await bundleGuide('layers/gpui/guide.md');
  const project = temporaryDirectory(onTestFinished, 'tau-guides-added-layer-');

  await writeStommeProject(project, { language: 'rust' });

  const session = await startMainSession(onTestFinished, project);
  const firstPrompt = await session.run();

  await writeStommeProject(project, { language: 'rust', layers: ['gpui'] });

  const secondPrompt = await session.run();

  expect(firstPrompt).not.toContain(gpuiGuide);
  expect(secondPrompt).toContain(gpuiGuide);
});

it("swaps the guides when the project's version changes", async ({ onTestFinished }) => {
  const project = temporaryDirectory(onTestFinished, 'tau-guides-version-');

  await writeStommeProject(project, { language: 'typescript', version: '0.2.0' });

  const session = await startMainSession(onTestFinished, project);
  const firstPrompt = await session.run();

  await writeStommeProject(project, { language: 'typescript', version: '0.3.0' });

  const secondPrompt = await session.run();

  expect(firstPrompt).toContain('# Stomme 0.2.0 coding guides');
  expect(secondPrompt).toContain('# Stomme 0.3.0 coding guides');
  expect(secondPrompt).not.toContain('# Stomme 0.2.0 coding guides');
});

it('loads the bundled guides without stomme.toml', async ({ onTestFinished }) => {
  const sharedGuide = await bundleGuide('shared/coding.md');
  const folder = temporaryDirectory(onTestFinished, 'tau-guides-bundle-');

  const prompt = await (await startMainSession(onTestFinished, folder)).run();

  expect(prompt).toContain(sharedGuide);
  expect(prompt).toContain('# Stomme 0.2.0 coding guides, bundled with Tau');
});

it('reports a broken installation', async ({ onTestFinished }) => {
  const sharedGuide = await bundleGuide('shared/coding.md');
  const project = temporaryDirectory(onTestFinished, 'tau-guides-broken-');
  const editedGuide = join(project, 'docs', 'stomme', 'shared', 'coding.md');

  await writeStommeProject(project, { language: 'typescript' });
  await writeFile(editedGuide, '# Edited by hand\n');

  const session = await startMainSession(onTestFinished, project);
  const firstPrompt = await session.run();
  const secondPrompt = await session.run();

  expect(session.notices).toHaveLength(1);
  expect(session.notices[0]).toMatch(/^error: Tau could not load the stomme coding guides: /);
  expect(session.notices[0]).toContain('shared/coding.md');

  for (const prompt of [firstPrompt, secondPrompt]) {
    expect(prompt).toContain('Tau could not load the stomme coding guides: ');
    expect(prompt).toContain('Tell the user before you change any code.');
    expect(prompt).not.toContain(sharedGuide);
  }
});

it('leaves stomme guides out of a worker without coding', async ({ onTestFinished }) => {
  const project = temporaryDirectory(onTestFinished, 'tau-guides-scout-');

  await writeStommeProject(project, { language: 'typescript' });

  const sharedGuide = await bundleGuide('shared/coding.md');
  const { prompt, notices } = await runWorker(onTestFinished, project, ['writing', 'workflow']);

  expect(notices).toEqual([]);
  expect(prompt).toContain('Work on the assigned task.');
  expect(prompt).not.toContain('# Stomme');
  expect(prompt).not.toContain(sharedGuide);
});
