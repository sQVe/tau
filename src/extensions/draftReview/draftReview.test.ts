import { expect, it } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import draftReviewExtension from './draftReview.js';
import { comment, fixture } from './fixtures/reviewFixture.js';

it('collects through the registered tool after the hc wait reports the terminal ended', async () => {
  const context = await fixture({ space: 'space-a' });
  const fake = fakeExtensionApi({ exec: context.exec });

  draftReviewExtension(fake.pi);

  const tool = fake.tools.get('draft_review');

  if (tool === undefined) {
    throw new Error('Missing draft_review tool');
  }

  const opened = await tool.execute(
    'open',
    { action: 'open', paths: ['.tau/slices/a.md'] },
    undefined,
    undefined,
    { cwd: context.repository } as never,
  );

  const directory = (opened.details as { directory: string }).directory;

  await context.setSession([comment('on-a', '01-slices/1-a.md')]);

  const collected = await tool.execute(
    'collect',
    { action: 'collect', directory },
    undefined,
    undefined,
    { cwd: context.repository } as never,
  );

  expect(collected.details).toMatchObject({
    status: 'reviewed',
    comments: [{ content: 'on-a' }],
  });

  expect(await context.deleted()).toEqual(['on-a']);
});
