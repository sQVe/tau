import type { Exec } from '../../../exec.js';

type ExecResult = Awaited<ReturnType<Exec>>;

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
  // Each gh call, as the arguments joined by spaces.
  calls: string[];
  defaultBranch: string;
  // The pull requests of the one repository the fake serves, github.com/sQVe/tau.
  pulls: FakePull[];
  // The stacks API answer for a pull request, bottom to top. A pull request without an entry has no stack.
  stacks: Record<number, number[]>;
  // The stacks API answers 404 for every pull request.
  stackedPullRequestsOff: boolean;
  stackView: { code: number; stdout: string; stderr: string };
  // Replaces the answer of the first call whose arguments start with prefix.
  override: (prefix: string, result: Partial<ExecResult>) => void;
}

const ok = (stdout: string): ExecResult => ({ code: 0, killed: false, stdout, stderr: '' });

const failure = (stderr: string, code = 1): ExecResult => ({
  code,
  killed: false,
  stdout: '',
  stderr,
});

const argumentAfter = (commandArguments: readonly string[], flag: string) => {
  const index = commandArguments.indexOf(flag);

  return index === -1 ? undefined : commandArguments[index + 1];
};

const repositoryUrl = 'https://github.com/sQVe/tau';

export const createStackFake = (): StackFake => {
  const calls: string[] = [];
  const overrides = new Map<string, Partial<ExecResult>>();

  const fake: StackFake = {
    exec: async () => failure('not set up'),
    calls,
    defaultBranch: 'main',
    pulls: [],
    stacks: {},
    stackedPullRequestsOff: false,
    stackView: { code: 2, stdout: '', stderr: 'no stack' },
    override: (prefix, result) => {
      overrides.set(prefix, result);
    },
  };

  const openPulls = () => fake.pulls.filter((pull) => (pull.state ?? 'OPEN') === 'OPEN');

  const listed = (commandArguments: readonly string[]) => {
    const head = argumentAfter(commandArguments, '--head');
    const base = argumentAfter(commandArguments, '--base');

    const matching = openPulls().filter(
      (pull) =>
        pull.headBranch === (head ?? pull.headBranch) &&
        pull.baseRefName === (base ?? pull.baseRefName),
    );

    return ok(
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
      return failure('Could not resolve to a PullRequest');
    }

    return ok(
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
      return failure('gh: Not Found (HTTP 404)');
    }

    const number = Number(/pull_request=(\d+)/u.exec(commandArguments[3] ?? '')?.[1]);

    const pullRequests = fake.stacks[number] ?? [];
    const stackNumber = pullRequests.length === 0 ? null : 100 + (pullRequests[0] ?? 0);

    return ok(JSON.stringify({ number: stackNumber, pullRequests }));
  };

  const answer = (commandArguments: readonly string[]): ExecResult => {
    const [first, second] = commandArguments;
    const command = `${first} ${second}`;

    if (command === 'stack view') {
      return { ...fake.stackView, killed: false };
    }

    if (command === 'pr list') {
      return listed(commandArguments);
    }

    if (command === 'pr view') {
      return viewed(commandArguments);
    }

    if (first === 'api') {
      return stacksApi(commandArguments);
    }

    if (command === 'repo view') {
      const view = { isFork: false, parent: null, defaultBranchRef: { name: fake.defaultBranch } };

      return ok(JSON.stringify(view));
    }

    return failure(`unexpected gh ${commandArguments.join(' ')}`);
  };

  fake.exec = async (command, commandArguments) => {
    if (command === 'ssh') {
      return failure('ssh: Could not resolve hostname', 255);
    }

    const joined = commandArguments.join(' ');

    calls.push(joined);

    const replaced = [...overrides].find(([prefix]) => joined.startsWith(prefix));
    const result = command === 'gh' ? answer(commandArguments) : failure(`unexpected ${command}`);

    return replaced === undefined ? result : { ...result, ...replaced[1] };
  };

  return fake;
};
