import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';

import { codingSetText, trackGuideRuns } from '../src/instructions/guideRuns.js';
import type { GuideRuns } from '../src/instructions/guideRuns.js';
import { resolveStommeGuides } from '../src/instructions/stommeGuides/stommeGuides.js';
import {
  bundleDirectory,
  bundleGuide,
  runWorker,
  startMainSession,
} from './guideSessionHarness.js';
import { createPiSession } from './piSession.js';
import { writeStommeProject } from './stommeProjectHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

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
