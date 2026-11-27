import { readFile } from 'node:fs/promises';

import type { Exec } from '../src/command.js';
import {
  argumentAfter,
  createExecFake,
  failedResult,
  isCommandOf,
  succeededResult,
} from './execFake.js';
import type { ExecCall, ExecResult } from './execFake.js';

interface FakeRepository {
  defaultBranch: string;
  // <owner>/<name> of the repository this one forks, on the same host.
  parent?: string;
}

export interface FakePullRequest {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  title: string;
  body: string;
  author?: string;
  baseRefName: string;
  isDraft: boolean;
  headRefOid: string;
  headOwner: string;
  // The head repository's name. The fake owner's repository is named tau unless a test says so.
  headRepository?: string;
  headBranch: string;
  // The committer date of the head commit. Defaults to a fixed date.
  headCommittedAt?: string;
  // The creation times of the head commit's check suites. Defaults to none.
  headCheckSuites?: string[];
  reviews?: { login: string; commit: string }[];
  comments?: { body: string; createdAt: string }[];
}

type CommandKey =
  | 'auth status'
  | 'repo view'
  | 'pr list'
  | 'pr view'
  | 'pr create'
  | 'pr edit'
  | 'pr comment'
  | 'api'
  | 'api write'
  | 'api user'
  | 'check-suites';

type WriteKey = 'pr create' | 'pr edit' | 'pr comment' | 'api write';

type ReadKey = Exclude<CommandKey, WriteKey>;

interface FakeWrite {
  key: WriteKey;
  commandArguments: string[];
  // The bytes of the file that --body-file or --input named.
  contents: Buffer;
}

export interface GhFake {
  exec: Exec;
  calls: ExecCall[];
  // Each publish command, with the bytes of the file it sent.
  writes: FakeWrite[];
  viewer: string;
  // Keyed by <host>/<owner>/<name>.
  repositories: Record<string, FakeRepository>;
  // Keyed by the base repository, <host>/<owner>/<name>.
  pullRequests: Record<string, FakePullRequest[]>;
  // The hostname `ssh -G` prints, keyed by the arguments after -G, such as `-p 2222 git@alias`.
  // ssh fails for any other arguments.
  sshHostnames: Record<string, string>;
  overrideOutput: (key: CommandKey, stdout: string) => void;
  failCommand: (key: CommandKey, stderr?: string) => void;
}

interface WriteFacts {
  fileFlag: '--body-file' | '--input';
  stdout: (commandArguments: readonly string[]) => string;
}

// gh pr list prints at most 30 pull requests unless --limit says otherwise.
const defaultListLimit = 30;

const commandKeys: Record<string, CommandKey> = {
  'auth status': 'auth status',
  'repo view': 'repo view',
  'pr list': 'pr list',
  'pr view': 'pr view',
  'pr create': 'pr create',
  'pr edit': 'pr edit',
  'pr comment': 'pr comment',
  'api --hostname': 'api',
  'api user': 'api user',
};

const writeFacts = {
  'pr create': {
    fileFlag: '--body-file',
    stdout: (commandArguments) =>
      `https://${argumentAfter(commandArguments, '--repo') ?? ''}/pull/8\n`,
  },
  'pr edit': { fileFlag: '--body-file', stdout: () => '' },
  'pr comment': {
    fileFlag: '--body-file',
    stdout: (commandArguments) =>
      `https://${argumentAfter(commandArguments, '--repo') ?? ''}/pull/${commandArguments[2] ?? ''}#issuecomment-1\n`,
  },
  'api write': {
    fileFlag: '--input',
    stdout: (commandArguments) => {
      const host = argumentAfter(commandArguments, '--hostname') ?? '';
      const endpoint = commandArguments.find((argument) => argument.startsWith('repos/')) ?? '';
      const [owner = '', name = '', , pr = ''] = endpoint.split('/').slice(1);

      return JSON.stringify({
        id: 1,
        state: 'PENDING',
        html_url: `https://${host}/${owner}/${name}/pull/${pr}#pullrequestreview-1`,
      });
    },
  },
} satisfies Record<WriteKey, WriteFacts>;

const fieldFlags = ['-f', '-F', '--field', '--raw-field'] as const;

const carriesWriteFields = (commandArguments: readonly string[]): boolean =>
  fieldFlags.some((field) => commandArguments.includes(field));

const writeKeys: ReadonlySet<WriteKey> = new Set<WriteKey>(
  Object.keys(writeFacts) as readonly WriteKey[],
);

const parentOutput = (parent: string | undefined) => {
  if (parent === undefined) {
    return null;
  }

  const [owner = '', name = ''] = parent.split('/');

  return { id: 'R_parent', name, owner: { id: 'U_owner', login: owner } };
};

const apiEndpoint = (commandArguments: readonly string[]): string =>
  commandArguments.find((argument) => argument.startsWith('repos/')) ?? '';

export const createGhFake = (): GhFake => {
  const repositoryView = (commandArguments: readonly string[]) => {
    const name = commandArguments[2] ?? '';
    const repository = fake.repositories[name];

    if (repository === undefined) {
      return undefined;
    }

    return {
      isFork: repository.parent !== undefined,
      parent: parentOutput(repository.parent),
      defaultBranchRef: { name: repository.defaultBranch },
    };
  };

  const pullRequestList = (commandArguments: readonly string[]) => {
    const repository = argumentAfter(commandArguments, '--repo') ?? '';
    const head = argumentAfter(commandArguments, '--head');
    const limit = Number(argumentAfter(commandArguments, '--limit') ?? defaultListLimit);
    const matching = (fake.pullRequests[repository] ?? []).filter((pr) => pr.headBranch === head);
    const listed = matching.slice(0, limit);

    return listed.map((pr) => ({
      number: pr.number,
      url: `https://${repository}/pull/${pr.number}`,
      state: pr.state,
      title: pr.title,
      body: pr.body,
      author: { login: pr.author ?? 'sQVe' },
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      headRefOid: pr.headRefOid,
      headRepositoryOwner: { id: `U_${pr.headOwner}`, login: pr.headOwner },
      headRepository: { id: `R_${pr.headOwner}`, name: pr.headRepository ?? 'tau' },
    }));
  };

  const pullRequestView = (commandArguments: readonly string[]) => {
    const repository = argumentAfter(commandArguments, '--repo') ?? '';
    const number = Number(commandArguments[2]);
    const pr = (fake.pullRequests[repository] ?? []).find((listed) => listed.number === number);

    if (pr === undefined) {
      return undefined;
    }

    return {
      url: `https://${repository}/pull/${pr.number}`,
      title: pr.title,
      body: pr.body,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      headRefOid: pr.headRefOid,
      // gh lists at most 100 commits, so a long pull request has no head among them.
      commits: [],
      reviews: (pr.reviews ?? []).map((review) => ({
        author: { login: review.login },
        commit: { oid: review.commit },
      })),
      comments: pr.comments ?? [],
    };
  };

  const view = (
    key: Exclude<ReadKey, 'auth status' | 'api' | 'api user' | 'check-suites'>,
    commandArguments: readonly string[],
  ) => {
    if (key === 'repo view') {
      return repositoryView(commandArguments);
    }

    if (key === 'pr list') {
      return pullRequestList(commandArguments);
    }

    return pullRequestView(commandArguments);
  };

  // gh api --jq prints raw lines, not JSON.
  const commitApi = (commandArguments: readonly string[]) => {
    const host = argumentAfter(commandArguments, '--hostname') ?? '';
    const path = apiEndpoint(commandArguments);
    const parts = path.split('/');
    const [owner, name, sha] = [parts[1], parts[2], parts[4]];
    const prs = fake.pullRequests[`${host}/${owner}/${name}`] ?? [];
    const head = prs.find((pr) => pr.headRefOid === sha);

    if (parts[5] === 'check-suites') {
      return (head?.headCheckSuites ?? []).map((createdAt) => `${createdAt}\n`).join('');
    }

    return head?.headCommittedAt ?? '2026-10-14T10:00:00Z';
  };

  const output = (key: ReadKey, commandArguments: readonly string[]) => {
    if (key === 'auth status') {
      return '';
    }

    if (key === 'api user') {
      return JSON.stringify({ login: fake.viewer });
    }

    if (key === 'api' || key === 'check-suites') {
      return commitApi(commandArguments);
    }

    const value = view(key, commandArguments);

    return value === undefined ? undefined : JSON.stringify(value);
  };

  const sshConfig = (commandArguments: readonly string[]) => {
    const hostname = fake.sshHostnames[commandArguments.slice(1).join(' ')];

    return hostname === undefined
      ? {
          code: 255,
          killed: false,
          truncated: false,
          stdout: '',
          stderr: 'ssh: Could not resolve hostname',
        }
      : {
          code: 0,
          killed: false,
          truncated: false,
          stdout: `user git\nhostname ${hostname}\nport 22\n`,
          stderr: '',
        };
  };

  const keyOf = (command: string, commandArguments: readonly string[]) => {
    const baseKey = commandKeys[commandArguments.slice(0, 2).join(' ')];

    if (command !== 'gh') {
      return undefined;
    }

    if (baseKey !== 'api') {
      return baseKey;
    }

    const readsCheckSuites = apiEndpoint(commandArguments).endsWith('/check-suites');

    if (readsCheckSuites) {
      return 'check-suites';
    }

    const method = argumentAfter(commandArguments, '--method');
    const readsWithMethod = method === 'GET';
    const writesMethod = method !== undefined && method !== 'GET';

    const carriesFields =
      carriesWriteFields(commandArguments) || commandArguments.includes('--input');

    const writesFields = !readsWithMethod && carriesFields;

    return writesMethod || writesFields ? 'api write' : baseKey;
  };

  const recordWrite = async (
    key: WriteKey,
    commandArguments: readonly string[],
  ): Promise<ExecResult> => {
    const { fileFlag: flag, stdout } = writeFacts[key];
    // The plan appends the real file flag after every option, so a title equal to the flag comes
    // first.
    const flagIndex = commandArguments.lastIndexOf(flag);
    const path = flagIndex === -1 ? undefined : commandArguments[flagIndex + 1];

    if (path === undefined) {
      if (flagIndex === -1 && key === 'api write' && carriesWriteFields(commandArguments)) {
        fake.writes.push({
          key,
          commandArguments: [...commandArguments],
          contents: Buffer.alloc(0),
        });

        return succeededResult(stdout(commandArguments));
      }

      return failedResult(`missing ${flag}`);
    }

    try {
      const contents = await readFile(path);

      fake.writes.push({ key, commandArguments: [...commandArguments], contents });
    } catch (error) {
      return failedResult(`could not read ${path}: ${String(error)}`);
    }

    return succeededResult(stdout(commandArguments));
  };

  const handlerFor = (key: CommandKey) => async (commandArguments: readonly string[]) => {
    if (isCommandOf(writeKeys, key)) {
      return recordWrite(key, commandArguments);
    }

    const stdout = output(key, commandArguments);

    return stdout === undefined
      ? failedResult('Could not resolve to a Repository')
      : succeededResult(stdout);
  };

  const shared = createExecFake<CommandKey>({
    keyOf,
    handlerFor,
    failureStderr: (key) => `${key} failed`,
  });

  const fake: GhFake = {
    calls: shared.calls,
    writes: [],
    viewer: 'sQVe',
    repositories: {},
    pullRequests: {},
    sshHostnames: {},
    overrideOutput: shared.overrideOutput,
    failCommand: shared.failCommand,
    exec: async (...callArguments: Parameters<Exec>) =>
      callArguments[0] === 'ssh' ? sshConfig(callArguments[1]) : shared.exec(...callArguments),
  };

  return fake;
};

export const pullRequest = (overrides: Partial<FakePullRequest> = {}): FakePullRequest => ({
  number: 7,
  state: 'OPEN',
  title: 'Add a feature',
  body: 'Adds it.',
  baseRefName: 'main',
  isDraft: true,
  headRefOid: 'abc123',
  headOwner: 'sQVe',
  headBranch: 'feature',
  ...overrides,
});

export const holdPullRequests = (
  fake: GhFake,
  repository: string,
  prs: FakePullRequest[],
): void => {
  fake.pullRequests[repository] = prs;
};
