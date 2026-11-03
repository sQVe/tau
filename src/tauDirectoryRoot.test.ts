import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createTemporaryBareRoot } from '../tests/gitRepository.js';
import { findTauRoot } from './tauDirectory.js';

const bareRootWithGitFile = async (
  registerCleanup: (cleanup: () => Promise<void>) => void,
  content: string | undefined,
) => {
  const root = await createTemporaryBareRoot(registerCleanup);

  if (content === undefined) {
    await rm(join(root, '.git'));
  } else {
    await writeFile(join(root, '.git'), content);
  }

  return { root, bare: join(root, '.bare') };
};

it.for([
  { name: 'a final newline', content: 'gitdir: .bare\n' },
  { name: 'CRLF line ends', content: 'gitdir: .bare\r\n' },
  { name: 'no final newline', content: 'gitdir: .bare' },
  { name: 'trailing spaces', content: 'gitdir: .bare  \n' },
])('finds the bare root from a .git file with $name', async ({ content }, { onTestFinished }) => {
  const { root, bare } = await bareRootWithGitFile(onTestFinished, content);

  await expect(findTauRoot(bare, 'handover')).resolves.toBe(await realpath(root));
});

it.for([
  { name: 'extra lines', content: 'gitdir: .bare\nextra\n' },
  { name: 'text before gitdir', content: 'see gitdir: .bare\n' },
  { name: 'a gitdir that points elsewhere', content: 'gitdir: .other\n' },
  { name: 'a gitdir that does not exist', content: 'gitdir: .missing\n' },
  { name: 'no .git file', content: undefined },
])(
  'falls back to the bare Git directory for a .git file with $name',
  async ({ content }, { onTestFinished }) => {
    const { root, bare } = await bareRootWithGitFile(onTestFinished, content);

    if (content === 'gitdir: .other\n') {
      await mkdir(join(root, '.other'));
    }

    await expect(findTauRoot(bare, 'handover')).resolves.toBe(await realpath(bare));
  },
);

it('throws when the .git file points through a file', async ({ onTestFinished }) => {
  const { bare } = await bareRootWithGitFile(onTestFinished, 'gitdir: .bare/HEAD/x\n');

  await expect(findTauRoot(bare, 'handover')).rejects.toMatchObject({ code: 'ENOTDIR' });
});
