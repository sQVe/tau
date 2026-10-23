import { expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { herdrFake } from '../../../tests/herdrFake.js';
import draftReviewExtension from './draftReview.js';
import { agentPane, comment, fixture } from './fixtures/reviewFixture.js';

it('keeps review comments while process liveness is unknown and collects only after confirmed exit', async () => {
  const { exec, repository, run, setSession, deleted, records } = await fixture(herdrFake());
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const { directory } = opened.details as { directory: string };

  await setSession([comment('on-a', '01-slices/1-a.md')]);
  const fake = fakeExtensionApi({ exec });
  draftReviewExtension(fake.pi);
  const tool = fake.tools.get('draft_review');

  if (tool === undefined) {
    throw new Error('Missing draft_review tool');
  }

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const probed = Promise.withResolvers<undefined>();

  const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
    probed.resolve(undefined);

    throw Object.assign(new Error('Probe failed'), { code: 'EINVAL' });
  });

  const controller = new AbortController();
  const context = { cwd: repository } as never;

  const collecting = tool.execute(
    'collect',
    { action: 'collect', directory },
    controller.signal,
    undefined,
    context,
  );

  collecting.catch(() => undefined);

  await probed.promise;
  controller.abort();
  await vi.advanceTimersByTimeAsync(100);
  await expect(collecting).rejects.toThrow('no comment was deleted');

  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);

  probe.mockImplementation(() => {
    throw Object.assign(new Error('Process exited'), { code: 'ESRCH' });
  });

  const collected = await tool.execute(
    'retry',
    { action: 'collect', directory },
    undefined,
    undefined,
    context,
  );

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(await deleted()).toEqual(['on-a']);
  expect(await records()).toEqual([]);
});
