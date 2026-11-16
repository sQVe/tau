import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createRunDirectory } from './fixtures/runDirectory.js';
import workerRecord from './workerRecord.js';

it('registers verification_record and saves a result through it', async () => {
  const run = 'delegate-a-check';
  const item = 'journeys/delegate-a-check';

  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 1 }],
  });

  const fake = fakeExtensionApi();
  workerRecord(fake.pi);

  const tool = fake.tools.get('verification_record');

  if (tool === undefined) {
    throw new Error('The extension did not register verification_record.');
  }

  const result = await tool.execute(
    'call-1',
    {
      run,
      item,
      steps: [{ status: 'passed', artifacts: [] }],
      endState: { status: 'passed' },
    },
    undefined,
    undefined,
    noUiContext(root),
  );

  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

  expect(JSON.parse(text)).toMatchObject({ status: 'saved', run, item });
  expect(existsSync(join(directory, 'items', 'journeys', 'delegate-a-check.json'))).toBe(true);
});
