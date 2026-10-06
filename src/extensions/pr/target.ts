import { Type } from 'typebox';

import { checkOutput, label, parseRepository, readJson, run } from '../../github.js';
import type { Repository, Runtime } from '../../github.js';
import { runGit } from '../../gitOutput.js';
import { readGit, readOptionalGit } from './git.js';
import {
  formatRepository,
  pickBaseBranch,
  pickBaseRemote,
  pickBaseRepository,
  pickHead,
  pickPullRequests,
  pickPushRepository,
  rejectDefaultBranch,
  upstreamRepository,
} from './targetDecisions.js';
import type {
  PullRequest,
  PushTarget,
  Remote,
  RemotePush,
  ViewedRepository,
} from './targetDecisions.js';

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
  urls: string[];
  pushUrls: string[];
  fetchRefspecs: string[];
}

// SSH reads the host as a Host alias from its config, which can also match on the user and port.
interface SshDestination {
  host: string;
  user: string;
  port: string;
}

interface RemoteLocation {
  host: string;
  path: string;
  ssh: SshDestination | undefined;
}

type ResolveHost = (destination: SshDestination) => Promise<string>;

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
    headRepository: Type.Union([Type.Object({ name: Type.String() }), Type.Null()]),
  }),
);

const pullRequestListLimit = 100;

const pullRequestFields =
  'number,url,state,title,body,baseRefName,isDraft,headRefOid,headRepositoryOwner,headRepository';

// Git prints the push remote only when branch.<name>.pushRemote, branch.<name>.remote, or
// remote.pushDefault names one, so an empty remote means the branch has no push target. With a
// push remote but no push ref, such as for a removed remote, the setting is broken.
const readPushTarget = async (cwd: string, branch: string): Promise<PushTarget | undefined> => {
  const output = await readGit(cwd, [
    'for-each-ref',
    '--format=%(push)%00%(push:remotename)%00%(push:remoteref)',
    `refs/heads/${branch}`,
  ]);

  const [trackingRef = '', remote = '', remoteRef = ''] = output.split('\0');

  if (remote === '') {
    return undefined;
  }

  if (trackingRef !== '') {
    return { remote, trackingRef, remoteRef: remoteRef === '' ? undefined : remoteRef };
  }

  const commandArguments = ['rev-parse', '--abbrev-ref', '@{push}'];
  const result = await runGit(cwd, commandArguments);

  throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
};

const lines = (text: string | undefined) => (text ?? '').split('\n').filter((line) => line !== '');

// Reads https://host/owner/name.git, ssh://git@host:port/owner/name.git, and
// git@host:owner/name.git. The port of an ssh:// URL is the SSH port, not part of the web host.
const parseRemoteUrl = (url: string): RemoteLocation | undefined => {
  const scp = /^(?:([\w.-]+)@)?([\w.-]+):(?!\/)(.+)$/u.exec(url);

  if (scp !== null) {
    const host = scp[2] ?? '';

    return { host, path: scp[3] ?? '', ssh: { host, user: scp[1] ?? '', port: '' } };
  }

  try {
    const parsed = new URL(url);
    const overSsh = parsed.protocol === 'ssh:';
    const host = overSsh ? parsed.hostname : parsed.host;
    const user = decodeURIComponent(parsed.username);
    const ssh = overSsh ? { host, user, port: parsed.port } : undefined;

    return { host, path: parsed.pathname.slice(1), ssh };
  } catch {
    return undefined;
  }
};

const locatedRepository = (host: string, path: string): Repository | undefined => {
  const name = path.replace(/\/$/u, '').replace(/\.git$/u, '');

  try {
    return parseRepository(`${host}/${name}`);
  } catch {
    return undefined;
  }
};

const remoteRepository = async (url: string, resolveHost: ResolveHost) => {
  const location = parseRemoteUrl(url);

  if (location === undefined) {
    return undefined;
  }

  const host = location.ssh === undefined ? location.host : await resolveHost(location.ssh);

  return locatedRepository(host, location.path);
};

const sshHostname = (output: string) =>
  lines(output)
    .find((line) => line.startsWith('hostname '))
    ?.slice('hostname '.length)
    .trim();

const sshTarget = ({ host, user }: SshDestination) => (user === '' ? host : `${user}@${host}`);

const sshArguments = (destination: SshDestination) => {
  const commandArguments = destination.port === '' ? [] : ['-p', destination.port];

  commandArguments.push(sshTarget(destination));

  return commandArguments;
};

// Resolves an SSH Host alias, such as github-work, to the hostname SSH connects to for that user and
// port. Keeps the host when ssh fails or prints no hostname, and never passes ssh a destination
// that it would read as an option.
const sshHostResolver = (runtime: Runtime): ResolveHost => {
  const resolved = new Map<string, Promise<string>>();

  const resolve = async (destination: SshDestination, commandArguments: string[]) => {
    const result = await runtime.exec('ssh', ['-G', ...commandArguments], {
      cwd: runtime.cwd,
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });

    const hostname = result.code === 0 && !result.killed ? sshHostname(result.stdout) : undefined;

    return hostname === undefined || hostname === '' ? destination.host : hostname;
  };

  return async (destination) => {
    if (sshTarget(destination).startsWith('-')) {
      return destination.host;
    }

    const commandArguments = sshArguments(destination);
    const key = commandArguments.join(' ');

    const known = resolved.get(key) ?? resolve(destination, commandArguments);

    resolved.set(key, known);

    return known;
  };
};

const remoteUrlKey = /^remote\.(.+)\.(url|pushurl|fetch)$/u;

// Reads every url, pushurl, and fetch refspec of each remote.
const readRemoteUrls = async (cwd: string) => {
  const output = await readOptionalGit(cwd, [
    'config',
    '--get-regexp',
    String.raw`^remote\..*\.((push)?url|fetch)$`,
  ]);

  const urls = new Map<string, RemoteUrls>();

  for (const line of lines(output)) {
    const [key = '', value = ''] = line.split(' ', 2);
    const [, name = '', kind] = remoteUrlKey.exec(key) ?? [];
    const remote = urls.get(name) ?? { urls: [], pushUrls: [], fetchRefspecs: [] };

    if (kind === 'url') {
      remote.urls.push(value);
    }

    if (kind === 'pushurl') {
      remote.pushUrls.push(value);
    }

    if (kind === 'fetch') {
      remote.fetchRefspecs.push(value);
    }

    urls.set(name, remote);
  }

  return urls;
};

// Git applies insteadOf and pushInsteadOf rewrites to the URLs it uses. A rewrite to a URL that
// names no GitHub repository, such as a local mirror path, keeps the configured URL.
const effectiveRepository = async (
  resolveHost: ResolveHost,
  expanded: string | undefined,
  configured: string,
): Promise<RemotePush> => {
  const url = expanded ?? configured;
  const repository = await remoteRepository(url, resolveHost);

  return repository === undefined
    ? { url: configured, repository: await remoteRepository(configured, resolveHost) }
    : { url, repository };
};

// git push sends to every push URL, so read them all. Git lists them in config order, as read.
const readPushes = async (
  cwd: string,
  resolveHost: ResolveHost,
  name: string,
  configured: readonly string[],
) => {
  const output = await readOptionalGit(cwd, ['remote', 'get-url', '--push', '--all', name]);
  const expanded = lines(output);
  const count = Math.max(expanded.length, configured.length);

  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      effectiveRepository(resolveHost, expanded[index], configured[index] ?? ''),
    ),
  );
};

const readRemote = async (
  cwd: string,
  resolveHost: ResolveHost,
  name: string,
  urls: RemoteUrls,
): Promise<Remote> => {
  // Git fetches from the first url, and pushes to every url when no pushurl is set.
  const [url = ''] = urls.urls;
  const pushUrls = urls.pushUrls.length === 0 ? urls.urls : urls.pushUrls;
  const fetchUrl = await readOptionalGit(cwd, ['remote', 'get-url', name]);
  const fetched = await effectiveRepository(resolveHost, fetchUrl, url);

  return {
    name,
    repository: fetched.repository,
    pushes: await readPushes(cwd, resolveHost, name, pushUrls),
    fetchRefspecs: urls.fetchRefspecs,
  };
};

const readRemotes = async (runtime: Runtime): Promise<Remote[]> => {
  const urls = await readRemoteUrls(runtime.cwd);
  const resolveHost = sshHostResolver(runtime);

  return Promise.all(
    [...urls].map(([name, remoteUrls]) => readRemote(runtime.cwd, resolveHost, name, remoteUrls)),
  );
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

// gh pr list prints at most --limit pull requests and does not say when it left some out.
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
    '--limit',
    String(pullRequestListLimit),
    '--json',
    pullRequestFields,
  ];

  const listed = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, pullRequestListSchema, listed);

  if (listed.length >= pullRequestListLimit) {
    throw new Error(
      `${label(commandArguments)} printed ${listed.length} pull requests, the limit, so the list may be incomplete. Check the pull requests for this branch on GitHub.`,
    );
  }

  return listed;
};

const resolveHead = async (runtime: Runtime, request: TargetRequest) => {
  const { cwd } = runtime;
  const branch = await readBranch(cwd);
  const remotes = await readRemotes(runtime);
  const pushTarget = await readPushTarget(cwd, branch);

  const head = pickHead({
    branch,
    pushTarget,
    requestedRemote: request.remote,
    remotes,
    remotesWithBranch: await readRemotesWithBranch(cwd, remotes, branch),
  });

  const remote = remotes.find((candidate) => candidate.name === head.remote);

  if (remote === undefined) {
    throw new Error(`remote ${head.remote} is not a Git remote of this checkout.`);
  }

  return { localBranch: branch, remotes, ...head, repository: pickPushRepository(remote) };
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

  return { headDefaultBranch: head.view.defaultBranch, ...pickBaseRepository(head, upstreamView) };
};

// Fetches into the tracking ref itself, since the remote's fetch refspec may leave the base out.
const pinMergeBase = async (cwd: string, remote: string, branch: string) => {
  const trackingRef = `refs/remotes/${remote}/${branch}`;

  await readGit(cwd, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${trackingRef}`]);

  return readGit(cwd, ['merge-base', trackingRef, 'HEAD']);
};

export const readTarget = async (runtime: Runtime, request: TargetRequest): Promise<Target> => {
  const { cwd } = runtime;
  const head = await resolveHead(runtime, request);
  const { host } = head.repository;

  await run(runtime, ['auth', 'status', '--active', '--hostname', host]);

  const base = await resolveBaseRepository(runtime, head.repository);

  rejectDefaultBranch({
    localBranch: head.localBranch,
    pushBranch: head.branch,
    headRepository: head.repository,
    defaultBranch: base.headDefaultBranch,
  });

  const baseRemote = pickBaseRemote(head.remotes, head.remote, base.repository);
  const listed = await readPullRequestList(runtime, base.repository, head.branch);
  const { pr, closedPrs } = pickPullRequests(listed, head.repository);

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
