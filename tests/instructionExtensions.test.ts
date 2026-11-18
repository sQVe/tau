import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect, it, vi } from 'vitest';

import {
  assignmentDirectory,
  assignmentPath,
  writeAssignment,
} from '../src/extensions/subagents/assignment.js';
import type { Loadout } from '../src/extensions/subagents/types.js';
import workerExtension from '../src/extensions/subagents/workerExtension.js';
import { workerStartMessage } from '../src/extensions/subagents/workerStart.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import { codingSetText, trackGuideRuns } from '../src/instructions/guideRuns.js';
import type { GuideRuns } from '../src/instructions/guideRuns.js';
import { resolveStommeGuides } from '../src/instructions/stommeGuides/stommeGuides.js';
import { skillTools } from '../src/skillTools.js';
import { createHcFake } from './hcFake.js';
import { createPiSession } from './piSession.js';
import { writeStommeProject } from './stommeProjectHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface PromptSession {
  run: () => Promise<string>;
  notices: string[];
}

interface WorkerRun {
  prompt: string;
  notices: string[];
}

interface WorkerLoadoutOptions {
  cwd: string;
  agentDirectory: string;
  model: string;
  instructionSets: Loadout['instructionSets'];
}

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

const instructionsExtensionPath = fileURLToPath(
  new URL('../src/extensions/instructions.ts', import.meta.url),
);

const bundleDirectory = fileURLToPath(new URL('../vendor/stomme', import.meta.url));

const safetyExtensionPath = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

// Pi-claude-bridge reads the append section at agent_start, after every handler has run.
const captureAppendSection = (appended: string[]) => (pi: ExtensionAPI) => {
  let options: { appendSystemPrompt?: string } = {};

  pi.on('before_agent_start', (event) => {
    options = event.systemPromptOptions;
  });

  pi.on('agent_start', () => {
    appended.push(options.appendSystemPrompt ?? '');
  });
};

const startMainSession = async (
  onTestFinished: TestContext['onTestFinished'],
  cwd: string,
): Promise<PromptSession> => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('TAU_ROLE', undefined);
  vi.stubEnv('TAU_WORKER_RECORD', undefined);

  const provider = fauxProvider({ provider: 'tau-guides-main' });
  const appended: string[] = [];
  const notices: string[] = [];

  const { session, extensionsResult } = await createPiSession(onTestFinished, {
    cwd,
    agentDirectory: join(cwd, '.agent'),
    providers: [provider],
    extensionPaths: [instructionsExtensionPath],
    extensionFactories: [captureAppendSection(appended)],
  });

  expect(extensionsResult.errors).toEqual([]);

  await session.bindExtensions({
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message: string, type?: string) => {
        notices.push(`${type ?? 'info'}: ${message}`);
      },
    },
  });

  return {
    notices,
    run: async () => {
      provider.setResponses([fauxAssistantMessage('Ready.')]);
      await session.prompt('Run.');

      return appended.at(-1) ?? '';
    },
  };
};

const workerLoadout = ({
  cwd,
  agentDirectory,
  model,
  instructionSets,
}: WorkerLoadoutOptions): Loadout => ({
  harness: 'pi',
  profile: 'worker',
  role: 'investigation',
  model,
  thinking: 'off',
  cwd,
  agentDirectory,
  permissions: 'trusted-full-tools',
  instructions: 'Work on the assigned task.',
  tools: ['read', 'bash'],
  skills: [],
  instructionSets,
  packages: [],
});

const runWorker = async (
  onTestFinished: TestContext['onTestFinished'],
  cwd: string,
  instructionSets: Loadout['instructionSets'],
): Promise<WorkerRun> => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-guides-agent-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('HC_TERMINAL_ID', 'worker');

  const provider = fauxProvider({ provider: 'tau-guides-worker' });
  const model = provider.getModel();

  const loadout = workerLoadout({
    cwd,
    agentDirectory,
    model: `${model.provider}/${model.id}`,
    instructionSets,
  });

  const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const sessionFile = join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`);

  await writeAssignment({
    version: 3,
    assignmentId,
    task: 'Inspect the project.',
    acceptance: [],
    label: null,
    profile: 'worker',
    loadout,
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: sessionFile },
    parentSession: join(agentDirectory, 'parent.jsonl'),
    cwd,
    parentTerminal: 'manager',
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [],
    report: null,
  });

  const hc = createHcFake();

  hc.reply(
    'get',
    JSON.stringify({
      address: 'worker',
      state: 'live',
      parent: 'manager',
      labels: { 'tau.assignment': assignmentPath(assignmentId) },
    }),
  );

  const appended: string[] = [];

  const { session, extensionsResult } = await createPiSession(onTestFinished, {
    cwd,
    agentDirectory,
    providers: [provider],
    tools: workerTools(loadout, skillTools),
    sessionManager: SessionManager.open(sessionFile),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionPaths: [safetyExtensionPath],
    extensionFactories: [
      (pi) => {
        pi.exec = hc.exec;

        workerExtension(pi);
      },
      captureAppendSection(appended),
    ],
  });

  expect(extensionsResult.errors).toEqual([]);

  const notices: string[] = [];

  provider.setResponses([0, 1, 2].map(() => fauxAssistantMessage('Ready.')));

  await session.bindExtensions({
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message: string) => {
        notices.push(message);
      },
    },
  });

  await session.prompt(workerStartMessage);

  return { prompt: appended[0] ?? '', notices };
};

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

const bundleGuide = async (path: string): Promise<string> =>
  (await readFile(join(bundleDirectory, path), 'utf8')).trim();

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

it('shows no broken-guide notice in a worker without coding', async ({ onTestFinished }) => {
  const project = temporaryDirectory(onTestFinished, 'tau-guides-broken-scout-');

  await writeStommeProject(project, { language: 'typescript' });
  await writeFile(join(project, 'docs', 'stomme', 'shared', 'coding.md'), '# Edited by hand\n');

  const { prompt, notices } = await runWorker(onTestFinished, project, ['writing', 'workflow']);

  expect(notices).toEqual([]);
  expect(prompt).toContain('Work on the assigned task.');
  expect(prompt).not.toContain('stomme coding guides');
});

it('reads the session working directory before the first run', async ({ onTestFinished }) => {
  const project = temporaryDirectory(onTestFinished, 'tau-guides-before-run-');
  const provider = fauxProvider({ provider: 'tau-guides-before-run' });
  let guideRuns: GuideRuns | undefined;

  await writeStommeProject(project, { language: 'rust', version: '0.3.0' });

  const { session } = await createPiSession(onTestFinished, {
    cwd: project,
    agentDirectory: join(project, '.agent'),
    providers: [provider],
    extensionFactories: [
      (pi) => {
        guideRuns = trackGuideRuns(pi);
      },
    ],
  });

  await session.bindExtensions({});

  const snapshot = await guideRuns?.snapshot();

  expect(process.cwd()).not.toBe(project);
  expect(snapshot).toEqual(await resolveStommeGuides(project));
});

it('names the real bundle folder in the source line of a bundled guide', async ({
  onTestFinished,
}) => {
  const folder = temporaryDirectory(onTestFinished, 'tau-guides-bundle-source-');

  const prompt = await (await startMainSession(onTestFinished, folder)).run();

  expect(prompt).toContain(`Source: ${join(bundleDirectory, 'shared', 'coding.md')}\n`);
  expect(prompt).not.toContain('Source: docs/stomme/');
});
