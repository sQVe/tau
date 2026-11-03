import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { holdPullRequests, pullRequest } from './fixtures/ghFake.js';
import {
  createBareRemote,
  createPublicationTool,
  githubUrl,
  pushFeature,
} from './fixtures/publicationRepository.js';

// A checkout whose origin is github.com/<origin>, with main pushed and the feature branch checked
// out. forkPoint is the SHA where feature leaves main.
const setUp = (origin?: string) =>
  createPublicationTool(onTestFinished, {
    ...(origin === undefined ? {} : { origin }),
    remote: true,
  });

it('targets a sole unpushed branch remote named publish', async () => {
  const { root, forkPoint, run } = await setUp();

  await git(root, 'remote', 'rename', 'origin', 'publish');

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    head: { remote: 'publish', branch: 'feature' },
    base: { remote: 'publish', branch: 'main' },
    mergeBase: forkPoint,
  });
});

it("targets a fork's upstream repository and fetches the base from its remote", async () => {
  const { root, fake, forkPoint, run } = await setUp('fork/tau');
  const upstreamUrl = 'git@github.com:sQVe/tau.git';
  const upstream = await createBareRemote(onTestFinished, upstreamUrl, root);

  await git(root, 'push', '--quiet', upstream, 'main');
  await git(root, 'remote', 'add', 'upstream', upstreamUrl);
  await pushFeature(root);

  fake.repositories['github.com/fork/tau'] = { defaultBranch: 'main', parent: 'sQVe/tau' };
  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };
  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest({ headOwner: 'fork' })]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    repository: 'github.com/sQVe/tau',
    head: { remote: 'origin', repository: 'github.com/fork/tau', owner: 'fork' },
    base: { remote: 'upstream', branch: 'main' },
    mergeBase: forkPoint,
    pr: { number: 7 },
  });
});

it('takes the head repository from the push URL of a remote that fetches from the upstream', async () => {
  const { root, fake, forkPoint, run } = await setUp();
  const forkUrl = githubUrl('fork/tau');

  await createBareRemote(onTestFinished, forkUrl, root);
  await git(root, 'config', 'remote.origin.pushurl', forkUrl);
  await pushFeature(root);

  fake.repositories['github.com/fork/tau'] = { defaultBranch: 'main', parent: 'sQVe/tau' };

  holdPullRequests(fake, 'github.com/sQVe/tau', [
    pullRequest({ number: 4, headOwner: 'sQVe' }),
    pullRequest({ headOwner: 'fork' }),
  ]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    repository: 'github.com/sQVe/tau',
    head: { remote: 'origin', repository: 'github.com/fork/tau', owner: 'fork' },
    base: { remote: 'origin', branch: 'main' },
    mergeBase: forkPoint,
    pr: { number: 7 },
  });
});

it('fetches the base from the remote that fetches the base repository, not one that pushes to it', async () => {
  const { root, fake, forkPoint, run } = await setUp('fork/tau');
  const upstreamUrl = githubUrl('sQVe/tau');
  const forkRemote = await git(root, 'remote', 'get-url', 'origin');

  await createBareRemote(onTestFinished, upstreamUrl, root);
  await git(root, 'push', '--quiet', forkRemote, 'feature:main');
  await git(root, 'config', 'remote.origin.pushurl', upstreamUrl);
  await git(root, 'push', '--quiet', upstreamUrl, 'main');
  await git(root, 'remote', 'add', 'upstream', upstreamUrl);
  await pushFeature(root);

  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    head: { remote: 'origin', repository: 'github.com/sQVe/tau' },
    base: { remote: 'upstream', branch: 'main' },
    mergeBase: forkPoint,
  });
});

it('takes the head repository from a pushInsteadOf rewrite', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', `url.${githubUrl('fork/tau')}.pushInsteadOf`, githubUrl('sQVe/tau'));

  fake.repositories['github.com/fork/tau'] = { defaultBranch: 'main', parent: 'sQVe/tau' };

  holdPullRequests(fake, 'github.com/sQVe/tau', [
    pullRequest({ number: 4, headOwner: 'sQVe' }),
    pullRequest({ headOwner: 'fork' }),
  ]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    repository: 'github.com/sQVe/tau',
    head: { remote: 'origin', repository: 'github.com/fork/tau', owner: 'fork' },
    base: { remote: 'origin', branch: 'main' },
    pr: { number: 7 },
  });
});

it('pins the merge base when the fetch refspec leaves out the base branch', async () => {
  const { root, forkPoint, run } = await setUp();

  const featureOnly = '+refs/heads/feature:refs/remotes/origin/feature';

  await pushFeature(root);
  await git(root, 'config', 'remote.origin.fetch', featureOnly);
  await git(root, 'update-ref', '-d', 'refs/remotes/origin/main');

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    base: { remote: 'origin', branch: 'main' },
    mergeBase: forkPoint,
  });
});

it('targets the named remote when the configured remote does not exist', async () => {
  const { root, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', 'branch.feature.remote', 'gone');

  const details = await run({ action: 'target', remote: 'origin' });

  expect(details).toMatchObject({
    head: { remote: 'origin' },
    base: { remote: 'origin', branch: 'main' },
  });
});

it('gathers evidence with the named remote when the configured remote does not exist', async () => {
  const { root, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', 'branch.feature.remote', 'gone');

  const evidence = await run({ action: 'evidence', remote: 'origin' });

  expect(evidence).toMatchObject({
    target: {
      head: { remote: 'origin' },
      base: { remote: 'origin', branch: 'main' },
    },
  });
});

it('refuses a branch whose configured remote does not exist', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', 'branch.feature.remote', 'gone');

  await expect(run({ action: 'target' })).rejects.toThrow(
    "git rev-parse --abbrev-ref @{push} failed: fatal: upstream branch 'refs/heads/feature' not stored as a remote-tracking branch",
  );

  expect(fake.calls).toEqual([]);
});

// Points origin at an SSH URL that Git still rewrites to the local bare repository.
const aliasOrigin = async (root: string, url: string) => {
  const bare = await git(root, 'remote', 'get-url', 'origin');

  await git(root, 'config', '--add', `url.${bare}.insteadOf`, url);
  await git(root, 'remote', 'set-url', 'origin', url);
};

// SSH config can match on the user and port, such as with `Match user git`, so the alias alone
// resolves to another host here.
it.each([
  { url: 'git@github-work:sQVe/tau.git', alias: 'github-work', destination: 'git@github-work' },
  {
    url: 'ssh://git@github-alt:2222/sQVe/tau.git',
    alias: 'github-alt',
    destination: '-p 2222 git@github-alt',
  },
])('resolves the SSH destination in $url', async ({ url, alias, destination }) => {
  const { root, fake, run } = await setUp();

  await aliasOrigin(root, url);
  await pushFeature(root);
  fake.sshHostnames[alias] = 'wrong.example.com';
  fake.sshHostnames[destination] = 'github.com';

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    host: 'github.com',
    repository: 'github.com/sQVe/tau',
    head: { remote: 'origin', repository: 'github.com/sQVe/tau' },
    base: { remote: 'origin', branch: 'main' },
  });

  expect(fake.calls[0]?.commandArguments).toEqual([
    'auth',
    'status',
    '--active',
    '--hostname',
    'github.com',
  ]);
});

it('reads the server branch through a custom fetch mapping', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/cache/*');
  await git(root, 'fetch', '--quiet', 'origin');
  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest()]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    head: { remote: 'origin', branch: 'feature' },
    base: { remote: 'origin', branch: 'main' },
    pr: { number: 7 },
  });
});

it('refuses a head remote whose push URLs name different repositories', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', '--add', 'remote.origin.pushurl', githubUrl('sQVe/tau'));
  await git(root, 'config', '--add', 'remote.origin.pushurl', githubUrl('other/tau'));

  await expect(run({ action: 'target' })).rejects.toThrow(
    'Remote origin pushes to several repositories: github.com/sQVe/tau, github.com/other/tau.',
  );

  expect(fake.calls).toEqual([]);
});
