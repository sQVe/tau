import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import { codingSetText, trackGuideRuns } from './guideRuns.js';
import type { GuideSnapshot } from './stommeGuides/stommeGuides.js';

const sessionContext = (notices: string[]): ExtensionContext =>
  ({
    cwd: '/project',
    ui: {
      notify: (message: string) => {
        notices.push(message);
      },
    },
  }) as unknown as ExtensionContext;

it('flattens line breaks of a broken reason in the prompt line and keeps them in the notice', async () => {
  const reason = 'docs/stomme/shared/coding.md is not in the record:\n  run stomme sync\r\nagain';
  const broken = { kind: 'broken', root: '/project', reason } satisfies GuideSnapshot;
  const notices: string[] = [];
  const fake = fakeExtensionApi();

  trackGuideRuns(fake.pi, { resolve: () => Promise.resolve(broken) });
  await fake.handler('before_agent_start')({}, sessionContext(notices));

  expect(codingSetText(broken)).toBe(
    'Tau could not load the stomme coding guides: docs/stomme/shared/coding.md is not in the record: run stomme sync again. Tell the user before you change any code.',
  );

  expect(notices).toEqual([`Tau could not load the stomme coding guides: ${reason}`]);
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
