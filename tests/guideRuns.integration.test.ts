import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';

import { trackGuideRuns } from '../src/instructions/guideRuns.js';
import type { GuideRuns } from '../src/instructions/guideRuns.js';
import { resolveStommeGuides } from '../src/instructions/stommeGuides/stommeGuides.js';
import { bundleDirectory, runWorker, startMainSession } from './guideSessionHarness.js';
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
