import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import { codingSetText, trackGuideRuns } from './guideRuns.js';
import type { GuideSnapshot } from './stommeGuides/stommeGuides.js';

interface Notice {
  message: string;
  level: string | undefined;
}

const sessionContext = (notices: Notice[]): ExtensionContext =>
  ({
    cwd: '/project',
    ui: {
      notify: (message: string, level?: string) => {
        notices.push({ message, level });
      },
    },
  }) as unknown as ExtensionContext;

const guide = (path: string) => ({ path, text: `  text of ${path}\n` });

const projectSnapshot = {
  kind: 'project',
  root: '/project',
  version: '1.2.3',
  language: 'rust',
  layers: [],
  guides: [guide('shared/coding.md'), guide('languages/rust/guide.md')],
  digest: 'digest',
} satisfies GuideSnapshot;

const bundleSnapshot = {
  kind: 'bundle',
  root: '/tau/vendor/stomme',
  version: '1.2.3',
  guides: [guide('shared/coding.md'), guide('shared/extra.md')],
  languageGuides: { rust: guide('languages/rust/guide.md'), typescript: guide('x') },
  digest: 'digest',
} satisfies GuideSnapshot;

const brokenSnapshot = (reason: string) =>
  ({ kind: 'broken', root: '/project', reason }) satisfies GuideSnapshot;

const startRuns = (snapshots: GuideSnapshot[], usesCodingSet?: () => Promise<boolean>) => {
  const notices: Notice[] = [];
  const fake = fakeExtensionApi();
  const queue = [...snapshots];

  trackGuideRuns(fake.pi, {
    ...(usesCodingSet === undefined ? {} : { usesCodingSet }),
    resolve: () => Promise.resolve(queue.shift() ?? brokenSnapshot('queue is empty')),
  });

  const run = () => fake.handler('before_agent_start')({}, sessionContext(notices));

  return { notices, run };
};

it('flattens line breaks of a broken reason in the prompt line and keeps them in the notice', async () => {
  const reason = 'docs/stomme/shared/coding.md is not in the record:\n  run stomme sync\r\nagain';
  const broken = { kind: 'broken', root: '/project', reason } satisfies GuideSnapshot;
  const notices: Notice[] = [];
  const fake = fakeExtensionApi();

  trackGuideRuns(fake.pi, { resolve: () => Promise.resolve(broken) });
  await fake.handler('before_agent_start')({}, sessionContext(notices));

  expect(codingSetText(broken)).toBe(
    'Tau could not load the stomme coding guides: docs/stomme/shared/coding.md is not in the record: run stomme sync again. Tell the user before you change any code.',
  );

  expect(notices).toEqual([
    { message: `Tau could not load the stomme coding guides: ${reason}`, level: 'error' },
  ]);
});

it('shows each broken reason once until the guides load again', async () => {
  const { notices, run } = startRuns([
    brokenSnapshot('first'),
    brokenSnapshot('first'),
    projectSnapshot,
    brokenSnapshot('first'),
    brokenSnapshot('second'),
  ]);

  for (let index = 0; index < 5; index += 1) {
    await run();
  }

  const reasons = notices.map(({ message }) => message.split(': ').at(-1));

  expect(reasons).toEqual(['first', 'first', 'second']);
});

it('shows no notice for guides that load', async () => {
  const { notices, run } = startRuns([projectSnapshot, bundleSnapshot]);

  await run();
  await run();

  expect(notices).toEqual([]);
});

it('shows no broken notice to a session without the coding set', async () => {
  const { notices, run } = startRuns([brokenSnapshot('first')], () => Promise.resolve(false));

  await run();

  expect(notices).toEqual([]);
});

it('reads the guides of the session directory on demand without changing the run', async () => {
  const fake = fakeExtensionApi();
  const cwds: string[] = [];

  const guideRuns = trackGuideRuns(fake.pi, {
    resolve: (cwd) => {
      cwds.push(cwd);

      return Promise.resolve(brokenSnapshot(cwd));
    },
  });

  await expect(guideRuns.current()).rejects.toThrow('before the Pi session started');
  expect(cwds).toEqual([]);

  await fake.handler('session_start')({}, sessionContext([]));
  await guideRuns.current();

  expect(cwds).toEqual(['/project']);
});

it('keeps the snapshot of a started run when current reads other facts', async () => {
  const fake = fakeExtensionApi();
  const queue: GuideSnapshot[] = [projectSnapshot, bundleSnapshot];

  const guideRuns = trackGuideRuns(fake.pi, {
    resolve: () => Promise.resolve(queue.shift() ?? brokenSnapshot('queue is empty')),
  });

  const context = sessionContext([]);

  await fake.handler('session_start')({}, context);
  await fake.handler('before_agent_start')({}, context);

  expect(await guideRuns.current()).toBe(bundleSnapshot);
  expect(await guideRuns.snapshot()).toBe(projectSnapshot);
});

describe('coding set text', () => {
  it('names the project folder and separates the guides by a blank line', () => {
    const text = codingSetText(projectSnapshot);
    const [heading = '', ...sections] = text.split('\n\n');

    expect(heading).toContain('1.2.3');
    expect(heading).toContain(join('/project', 'docs', 'stomme'));

    expect(sections).toEqual([
      'Source: docs/stomme/shared/coding.md',
      'text of shared/coding.md',
      'Source: docs/stomme/languages/rust/guide.md',
      'text of languages/rust/guide.md',
    ]);
  });

  it('names the bundle without a project folder', () => {
    const text = codingSetText(bundleSnapshot);
    const [heading = ''] = text.split('\n\n');

    expect(heading).toContain('1.2.3');
    expect(heading).not.toContain('docs');
    expect(heading).toMatch(/\w$/);
    expect(text).toContain('Source: /tau/vendor/stomme/shared/extra.md');
  });
});

it('refuses a snapshot before the session starts', async () => {
  const fake = fakeExtensionApi();
  const cwds: string[] = [];

  const guideRuns = trackGuideRuns(fake.pi, {
    resolve: (cwd) => {
      cwds.push(cwd);

      return Promise.resolve({ kind: 'broken', root: cwd, reason: 'unused' });
    },
  });

  await expect(guideRuns.snapshot()).rejects.toThrow('before the Pi session started');
  expect(cwds).toEqual([]);
});
