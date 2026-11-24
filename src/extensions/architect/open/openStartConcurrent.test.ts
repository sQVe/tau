import { expect, it } from 'vitest';

import { appCommands, openTool, requestFor } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { startingError, openArchitect } from './open.js';

const barrier = (): (() => Promise<void>) => {
  let arrivals = 0;
  const bothArrived = Promise.withResolvers<undefined>();

  return async () => {
    arrivals += 1;

    if (arrivals === 2) {
      bothArrived.resolve(undefined);
    }

    await bothArrived.promise;
  };
};

it('two opens started together start one architect', async ({ onTestFinished: cleanup }) => {
  const { root, config } = await setup(cleanup);
  const { app, runtime } = openTool(root);

  await recordSession(root);

  const shared = barrier();
  const request = requestFor(root, config.location, runtime);

  const results = await Promise.allSettled([
    openArchitect(request, { beforeLink: shared }),
    openArchitect(request, { beforeLink: shared }),
  ]);

  const splits = appCommands(app).filter((name) => name === 'pane.split');

  expect(splits).toHaveLength(1);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);

  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
    message: startingError(root).message,
  });
});
