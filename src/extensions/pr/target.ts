import { Type } from 'typebox';

import { checkOutput, parseRepository, readJson, run } from '../../github.js';
import type { Repository, Runtime } from '../../github.js';
import { runGit } from '../../gitOutput.js';
import {
  formatRepository,
  pickBaseBranch,
  pickBaseRemote,
  pickBaseRepository,
  pickHead,
  pickPullRequests,
  upstreamRepository,
} from './targetDecisions.js';
import type { PullRequest, Remote, ViewedRepository } from './targetDecisions.js';

export interface TargetRequest {
  remote: string | undefined;
  base: string | undefined;
}

export interface Target {
  host: string;
  repository: string;
  head: { remote: string; repository: string; owner: string; branch: string; sha: string };
  base: { remote: string; branch: string };
  mergeBase: string;
  pr: PullRequest | null;
  closedPrs: PullRequest[];
}

interface RemoteUrls {
  url: string | undefined;
  pushUrl: string | undefined;
}

interface RemoteUrl extends Remote {
  pushUrl: string;
}

const repositoryViewSchema = Type.Object({
  isFork: Type.Boolean(),
  parent: Type.Union([
    Type.Object({ name: Type.String(), owner: Type.Object({ login: Type.String() }) }),
    Type.Null(),
  ]),
  defaultBranchRef: Type.Object({ name: Type.String() }),
});

const pullRequestListSchema = Type.Array(
  Type.Object({
    number: Type.Integer(),
    url: Type.String(),
    state: Type.String(),
    title: Type.String(),
    body: Type.String(),
    baseRefName: Type.String(),
    isDraft: Type.Boolean(),
    headRefOid: Type.String(),
    headRepositoryOwner: Type.Object({ login: Type.String() }),
  }),
);

const pullRequestFields =
  'number,url,state,title,body,baseRefName,isDraft,headRefOid,headRepositoryOwner';

// Resolves the trimmed output, or undefined when Git exits with 1.
const readOptionalGit = async (cwd: string, commandArguments: string[]) => {
  const result = await runGit(cwd, commandArguments);

  if (result.exitCode === 1) {
    return undefined;
  }

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout.toString('utf8').trim();
};

const readGit = async (cwd: string, commandArguments: string[]) => {
  const result = await runGit(cwd, commandArguments);

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout.toString('utf8').trim();
};

// Git exits with 128 when the branch has no upstream, so any failure means no push target.
const readPushTarget = async (cwd: string) => {
  const result = await runGit(cwd, ['rev-parse', '--abbrev-ref', '@{push}']);

  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
};

const lines = (text: string | undefined) => (text ?? '').split('\n').filter((line) => line !== '');

// Reads https://host/owner/name.git, ssh://git@host/owner/name.git, and git@host:owner/name.git.
const urlRepositoryPath = (url: string) => {
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/u.exec(url);

  if (scp !== null) {
    return `${scp[1]}/${scp[2]}`;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.protocol === 'ssh:' ? parsed.hostname : parsed.host;

    return `${host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
};

const remoteRepository = (url: string): Repository | undefined => {
  const path = urlRepositoryPath(url)
    ?.replace(/\/$/u, '')
    .replace(/\.git$/u, '');

  if (path === undefined) {
    return undefined;
  }

  try {
    return parseRepository(path);
  } catch {
    return undefined;
  }
};

const remoteUrlKey = /^remote\.(.+)\.(url|pushurl)$/u;

// Reads the first url and pushurl of each remote. Git pushes to pushurl when it is set.
const readRemoteUrls = async (cwd: string) => {
  const output = await readOptionalGit(cwd, [
    'config',
    '--get-regexp',
    String.raw`^remote\..*\.(push)?url$`,
  ]);

  const urls = new Map<string, RemoteUrls>();

  for (const line of lines(output)) {
    const [key = '', value = ''] = line.split(' ', 2);
    const [, name = '', kind] = remoteUrlKey.exec(key) ?? [];
    const remote = urls.get(name) ?? { url: undefined, pushUrl: undefined };

    if (kind === 'url') {
      remote.url ??= value;
    }

    if (kind === 'pushurl') {
      remote.pushUrl ??= value;
    }

    urls.set(name, remote);
  }

  return urls;
};

const readRemotes = async (cwd: string): Promise<RemoteUrl[]> => {
  const urls = await readRemoteUrls(cwd);

  return [...urls].map(([name, { url = '', pushUrl = url }]) => ({
    name,
    pushUrl,
    repository: remoteRepository(url),
    pushRepository: remoteRepository(pushUrl),
  }));
};

const readBranch = async (cwd: string) => {
  const branch = await readOptionalGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

  if (branch === undefined) {
    throw new Error('HEAD is detached. Check out the branch the pull request is for.');
  }

  return branch;
};

const readRemotesWithBranch = async (cwd: string, remotes: readonly Remote[], branch: string) => {
  const refs = lines(await readGit(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes/']));

  return remotes
    .map((remote) => remote.name)
    .filter((name) => refs.includes(`refs/remotes/${name}/${branch}`));
};

const readRepositoryView = async (runtime: Runtime, repository: Repository) => {
  const commandArguments = [
    'repo',
    'view',
    formatRepository(repository),
    '--json',
    'isFork,parent,defaultBranchRef',
  ];

  const view = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, repositoryViewSchema, view);

  return view;
};

const readPullRequestList = async (runtime: Runtime, repository: Repository, branch: string) => {
  const commandArguments = [
    'pr',
    'list',
    '--repo',
    formatRepository(repository),
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    pullRequestFields,
  ];

  const listed = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, pullRequestListSchema, listed);

  return listed;
};

const resolveHead = async (cwd: string, request: TargetRequest) => {
  const branch = await readBranch(cwd);
  const remotes = await readRemotes(cwd);
  const pushTarget = await readPushTarget(cwd);

  const head = pickHead({
    branch,
    pushTarget,
    requestedRemote: request.remote,
    remotes,
    remotesWithBranch: await readRemotesWithBranch(cwd, remotes, branch),
  });

  const remote = remotes.find((candidate) => candidate.name === head.remote);

  if (remote?.pushRepository === undefined) {
    throw new Error(
      `The push URL of remote ${head.remote}, ${remote?.pushUrl ?? 'none'}, does not name a GitHub repository.`,
    );
  }

  return { localBranch: branch, remotes, ...head, repository: remote.pushRepository };
};

const viewRepository = async (
  runtime: Runtime,
  repository: Repository,
): Promise<ViewedRepository> => {
  const view = await readRepositoryView(runtime, repository);

  return {
    repository,
    view: {
      parent:
        view.parent === null ? null : { owner: view.parent.owner.login, name: view.parent.name },
      defaultBranch: view.defaultBranchRef.name,
    },
  };
};

const resolveBaseRepository = async (runtime: Runtime, headRepository: Repository) => {
  const head = await viewRepository(runtime, headRepository);
  const upstream = upstreamRepository(headRepository, head.view);
  const upstreamView = upstream === undefined ? undefined : await viewRepository(runtime, upstream);

  return pickBaseRepository(head, upstreamView);
};

// Fetches into the tracking ref itself, since the remote's fetch refspec may leave the base out.
const pinMergeBase = async (cwd: string, remote: string, branch: string) => {
  const trackingRef = `refs/remotes/${remote}/${branch}`;

  await readGit(cwd, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${trackingRef}`]);

  return readGit(cwd, ['merge-base', trackingRef, 'HEAD']);
};

export const readTarget = async (runtime: Runtime, request: TargetRequest): Promise<Target> => {
  const { cwd } = runtime;
  const head = await resolveHead(cwd, request);
  const { host } = head.repository;

  await run(runtime, ['auth', 'status', '--active', '--hostname', host]);

  const base = await resolveBaseRepository(runtime, head.repository);

  if (head.localBranch === base.defaultBranch) {
    throw new Error(
      `${head.localBranch} is the default branch of ${formatRepository(base.repository)}. Check out a feature branch.`,
    );
  }

  const baseRemote = pickBaseRemote(head.remotes, head, base.repository);
  const listed = await readPullRequestList(runtime, base.repository, head.branch);
  const { pr, closedPrs } = pickPullRequests(listed, head.repository.owner);

  const baseBranch = pickBaseBranch({
    pr,
    requestedBase: request.base,
    defaultBranch: base.defaultBranch,
  });

  return {
    host,
    repository: formatRepository(base.repository),
    head: {
      remote: head.remote,
      repository: formatRepository(head.repository),
      owner: head.repository.owner,
      branch: head.branch,
      sha: await readGit(cwd, ['rev-parse', 'HEAD']),
    },
    base: { remote: baseRemote, branch: baseBranch },
    mergeBase: await pinMergeBase(cwd, baseRemote, baseBranch),
    pr,
    closedPrs,
  };
};
