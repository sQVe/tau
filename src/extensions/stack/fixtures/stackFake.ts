import {
  argumentAfter,
  createExecFake,
  failedResult,
  succeededResult,
} from '../../../../tests/execFake.js';
import type { ExecCall, ExecHandler } from '../../../../tests/execFake.js';
import type { Exec } from '../../../command.js';

export interface FakePull {
  number: number;
  headBranch: string;
  baseRefName: string;
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
  headOwner?: string;
  headRepository?: string;
}

export interface StackFake {
  exec: Exec;
  calls: ExecCall[];
  defaultBranch: string;
  // The pull requests of the one repository the fake serves, github.com/sQVe/tau.
  pulls: FakePull[];
  // The stacks API answer for a pull request, bottom to top. A pull request without an entry has no stack.
  stacks: Record<number, number[]>;
  // The stacks API answers 404 for every pull request.
  stackedPullRequestsOff: boolean;
  stackView: { code: number; stdout: string; stderr: string };
  // The keys are `stack view`, `pr list --head`, `pr list --base`, `pr view <number>`, `api`, and `repo view`.
  overrideOutput: (key: string, stdout: string) => void;
  failCommand: (key: string, stderr?: string) => void;
}

export const joinedCalls = (fake: StackFake): string[] =>
  fake.calls.map((call) => call.commandArguments.join(' '));

const repositoryUrl = 'https://github.com/sQVe/tau';

const stackKeyOf = (command: string, commandArguments: readonly string[]): string | undefined => {
  const [first, second] = commandArguments;
  const subcommand = `${first} ${second}`;

  if (command !== 'gh') {
    return undefined;
  }

  if (subcommand === 'pr list') {
    const flag = ['--head', '--base'].find((candidate) => commandArguments.includes(candidate));

    return flag === undefined ? subcommand : `${subcommand} ${flag}`;
  }

  if (subcommand === 'pr view') {
    return `${subcommand} ${commandArguments[2]}`;
  }

  return first === 'api' ? 'api' : subcommand;
};

export const createStackFake = (): StackFake => {
  const openPulls = () => fake.pulls.filter((pull) => (pull.state ?? 'OPEN') === 'OPEN');

  const listed = (commandArguments: readonly string[]) => {
    const head = argumentAfter(commandArguments, '--head');
    const base = argumentAfter(commandArguments, '--base');

    const matching = openPulls().filter(
      (pull) =>
        pull.headBranch === (head ?? pull.headBranch) &&
        pull.baseRefName === (base ?? pull.baseRefName),
    );

    return succeededResult(
      JSON.stringify(
        matching.map((pull) => ({
          number: pull.number,
          url: `${repositoryUrl}/pull/${pull.number}`,
          baseRefName: pull.baseRefName,
          headRefName: pull.headBranch,
          headRepositoryOwner: { login: pull.headOwner ?? 'sQVe' },
          headRepository: { name: pull.headRepository ?? 'tau' },
        })),
      ),
    );
  };

  const viewed = (commandArguments: readonly string[]) => {
    const pull = fake.pulls.find((candidate) => candidate.number === Number(commandArguments[2]));

    if (pull === undefined) {
      return failedResult('Could not resolve to a PullRequest');
    }

    return succeededResult(
      JSON.stringify({
        number: pull.number,
        headRefName: pull.headBranch,
        baseRefName: pull.baseRefName,
        state: pull.state ?? 'OPEN',
      }),
    );
  };

  const stacksApi = (commandArguments: readonly string[]) => {
    if (fake.stackedPullRequestsOff) {
      return failedResult('gh: Not Found (HTTP 404)');
    }

    const number = Number(/pull_request=(\d+)/u.exec(commandArguments[3] ?? '')?.[1]);

    const pullRequests = fake.stacks[number] ?? [];

    if (pullRequests.length === 0) {
      return succeededResult('[]');
    }

    const stack = {
      number: 100 + (pullRequests[0] ?? 0),
      pull_requests: pullRequests.map((pullRequest) => ({ number: pullRequest })),
    };

    return succeededResult(JSON.stringify([stack]));
  };

  const repositoryView = () => {
    const view = { isFork: false, parent: null, defaultBranchRef: { name: fake.defaultBranch } };

    return succeededResult(JSON.stringify(view));
  };

  const handlers: Record<string, ExecHandler> = {
    'stack view': () => ({ ...fake.stackView, killed: false }),
    'pr list --head': listed,
    'pr list --base': listed,
    'pr list': listed,
    api: stacksApi,
    'repo view': repositoryView,
  };

  const handlerFor = (key: string): ExecHandler | undefined => {
    const handler = key.startsWith('pr view ') ? viewed : handlers[key];

    // Pi's exec kills a command whose signal is already aborted and returns no output.
    return handler === undefined
      ? undefined
      : (commandArguments, options) =>
          options?.signal?.aborted === true
            ? { code: 1, killed: true, stdout: '', stderr: '' }
            : handler(commandArguments, options);
  };

  const shared = createExecFake({ keyOf: stackKeyOf, handlerFor });

  const fake: StackFake = {
    calls: shared.calls,
    exec: async (...callArguments: Parameters<Exec>) =>
      callArguments[0] === 'ssh'
        ? failedResult('ssh: Could not resolve hostname', 255)
        : shared.exec(...callArguments),
    defaultBranch: 'main',
    pulls: [],
    stacks: {},
    stackedPullRequestsOff: false,
    stackView: { code: 2, stdout: '', stderr: 'no stack' },
    overrideOutput: shared.overrideOutput,
    failCommand: shared.failCommand,
  };

  return fake;
};
