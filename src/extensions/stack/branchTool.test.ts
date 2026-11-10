import { expect, it, onTestFinished } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { git } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createStackCheckout } from './fixtures/checkout.js';
import { createStackFake } from './fixtures/stackFake.js';
import stackExtension from './stack.js';

it('registers a separate tool that creates a branch with local writes', async () => {
  const root = await createStackCheckout(onTestFinished);
  const fake = createStackFake();
  const extension = fakeExtensionApi({ exec: fake.exec });

  await git(root, 'branch', 'parent');
  await git(root, 'push', '--quiet', 'origin', 'parent');
  fake.trackBranches(root, []);
  stackExtension(extension.pi);

  const result = await extension.tools
    .get('stack_branch')
    ?.execute(
      'call',
      { parent: 'parent', branch: 'child', trunk: 'main', remote: 'origin' },
      undefined,
      undefined,
      noUiContext(root),
    );

  expect(result?.details).toMatchObject({ result: 'created' });
  expect(await git(root, 'branch', '--show-current')).toBe('child');
});
