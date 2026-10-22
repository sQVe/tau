import { Type } from 'typebox';

import type { CommandRuntime } from '../command.js';
import { readGit, readOptionalGit, runGit } from '../gitOutput.js';
import { checkOutput, parseRepository, readJson } from './github.js';
import type { Repository } from './github.js';
import {
  formatRepository,
  parseRemoteUrl,
  pickBaseRepository,
  pickHead,
  pickPushRepository,
  upstreamRepository,
} from './repositoryTargetDecisions.js';
import type {
  PushTarget,
  Remote,
  RemotePush,
  SshDestination,
  ViewedRepository,
} from './repositoryTargetDecisions.js';

export type OriginRepository =
  | { status: 'missing' }
  | { status: 'unnamed' }
  | { status: 'named'; repository: Repository };

export interface HeadRequest {
  remote: string | undefined;
  // The local branch to resolve. Defaults to the checked-out branch.
  branch?: string | undefined;
}

interface RemoteUrls {
  urls: string[];
  pushUrls: string[];
  fetchRefspecs: string[];
}

type ResolveHost = (destination: SshDestination) => Promise<string>;

export interface ResolvedHead {
  localBranch: string;
  remotes: Remote[];
  remote: string;
  // The branch name on the remote.
  branch: string;
  repository: Repository;
}

export interface ResolvedBase {
  repository: Repository;
  defaultBranch: string;
  // The default branch of the head repository, which may differ from its upstream's.
  headDefaultBranch: string;
}

const repositoryViewSchema = Type.Object({
  isFork: Type.Boolean(),
  parent: Type.Union([
    Type.Object({ name: Type.String(), owner: Type.Object({ login: Type.String() }) }),
    Type.Null(),
  ]),
  defaultBranchRef: Type.Object({ name: Type.String() }),
});

const lines = (text: string | undefined) => (text ?? '').split('\n').filter((line) => line !== '');

// Git prints the push remote only when branch.<name>.pushRemote, branch.<name>.remote, or
// remote.pushDefault names one, so an empty remote means the branch has no push target. With a
// push remote but no push ref, such as for a removed remote, the setting is broken.
const readPushTarget = async (cwd: string, branch: string): Promise<PushTarget | undefined> => {
  const output = await readGit(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(push)%00%(push:remotename)%00%(push:remoteref)',
    `refs/heads/${branch}`,
  ]);

  // for-each-ref also lists the branches below refs/heads/<branch>/, so keep the exact ref.
  const exact = lines(output).find((line) => line.startsWith(`refs/heads/${branch}\0`)) ?? '';
  const [, trackingRef = '', remote = '', remoteRef = ''] = exact.split('\0');

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
const sshHostResolver = (runtime: CommandRuntime): ResolveHost => {
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

const originTimeoutMilliseconds = 5000;

// Session start waits for this, so a checkout outside a repository, a missing origin, and a Git
// failure all read as no origin.
const readOriginUrl = async (cwd: string): Promise<string | undefined> => {
  try {
    const result = await runGit(cwd, ['remote', 'get-url', 'origin'], originTimeoutMilliseconds);

    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
  } catch {
    return undefined;
  }
};

export const readOriginRepository = async (runtime: CommandRuntime): Promise<OriginRepository> => {
  const url = await readOriginUrl(runtime.cwd);

  if (url === undefined) {
    return { status: 'missing' };
  }

  const repository = await remoteRepository(url, sshHostResolver(runtime));

  return repository === undefined ? { status: 'unnamed' } : { status: 'named', repository };
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

const readRemotes = async (runtime: CommandRuntime): Promise<Remote[]> => {
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

const readRepositoryView = async (runtime: CommandRuntime, repository: Repository) => {
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

export const resolveHead = async (
  runtime: CommandRuntime,
  request: HeadRequest,
): Promise<ResolvedHead> => {
  const { cwd } = runtime;
  const branch = request.branch ?? (await readBranch(cwd));
  const remotes = await readRemotes(runtime);
  const inferRemote = request.remote === undefined;
  const pushTarget = inferRemote ? await readPushTarget(cwd, branch) : undefined;
  const remotesWithBranch = inferRemote ? await readRemotesWithBranch(cwd, remotes, branch) : [];

  const head = pickHead({
    branch,
    pushTarget,
    requestedRemote: request.remote,
    remotes,
    remotesWithBranch,
  });

  const remote = remotes.find((candidate) => candidate.name === head.remote);

  if (remote === undefined) {
    throw new Error(`remote ${head.remote} is not a Git remote of this checkout.`);
  }

  return { localBranch: branch, remotes, ...head, repository: pickPushRepository(remote) };
};

const viewRepository = async (
  runtime: CommandRuntime,
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

export const resolveBaseRepository = async (
  runtime: CommandRuntime,
  headRepository: Repository,
): Promise<ResolvedBase> => {
  const head = await viewRepository(runtime, headRepository);
  const upstream = upstreamRepository(headRepository, head.view);
  const upstreamView = upstream === undefined ? undefined : await viewRepository(runtime, upstream);

  return { headDefaultBranch: head.view.defaultBranch, ...pickBaseRepository(head, upstreamView) };
};
