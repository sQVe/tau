import { readFile } from 'node:fs/promises';

import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { findTauRoot } from '../../tauDirectory.js';
import { findReusedLog, readRepository, runAndRecord, withRepositoryLock } from './checkFlow.js';
import type { Recorded } from './checkFlow.js';
import { readCheckIdentity } from './identity.js';
import { readMutationArgv } from './mutationConfig.js';
import { parseMutationReport } from './mutationReport.js';
import type { MutationReport, MutationStatus, Survivor } from './mutationReport.js';
import { mutationPassed, runWasStopped } from './mutationVerdict.js';
import type { CheckIdentity } from './reuseDecision.js';
import { stdoutPathOf } from './run.js';
import type { CheckResult } from './run.js';

interface MutationVerdict extends CheckResult {
  status: MutationStatus | undefined;
  error?: string;
  survivors: Survivor[];
  unmutated: string[];
}

export type MutationDetails = Recorded<MutationVerdict>;

export interface MutationCheckToolOptions {
  agentDirectory?: string;
  pollMilliseconds?: number;
  idleLimitMilliseconds?: number;
}

interface MutationRequest {
  mode: 'changed' | 'audit';
  base?: string;
  paths?: string[];
  maxMutants?: number;
}

interface Plan {
  argv: string[];
  base: string | null;
}

const parameters = Type.Object({
  mode: Type.Union([Type.Literal('changed'), Type.Literal('audit')], {
    description:
      '"changed" mutates the lines changed since the base. "audit" mutates the whole files in paths.',
  }),
  base: Type.Optional(
    Type.String({
      description:
        "Changed mode only. Ref or commit the change is based on. Defaults to the origin remote's default branch.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Audit mode only. A non-empty list of files to mutate.',
    }),
  ),
  maxMutants: Type.Optional(
    Type.Integer({ minimum: 1, description: 'Cap on the mutants of one run.' }),
  ),
});

// Mutation logs and records stay apart from full checks, whose passing verdict differs.
const mutationChecksPath = 'checks/mutation';
const defaultPollMilliseconds = 500;
const millisecondsPerMinute = 60_000;
const idleLimitMinutes = 10;
const defaultIdleLimitMilliseconds = idleLimitMinutes * millisecondsPerMinute;

const readAuditPaths = (request: MutationRequest): string[] => {
  const { paths = [] } = request;

  if (request.base !== undefined) {
    throw new Error('The base parameter belongs to changed mode, not audit mode.');
  }

  if (paths.length === 0) {
    throw new Error('Audit mode needs a non-empty paths list.');
  }

  const option = paths.find((path) => path.startsWith('-'));

  if (option !== undefined) {
    throw new Error(`The path ${option} must be a file path, not an option.`);
  }

  return paths;
};

// The identity of a run: the full argv, and a base that is null in audit mode.
const readMutationIdentity = async (
  root: string,
  argv: string[],
  base: string | null,
): Promise<CheckIdentity> => {
  const identity = await readCheckIdentity(root, argv, base ?? undefined);

  return base === null ? { ...identity, base: null } : identity;
};

const withLimit = (argv: string[], maxMutants: number | undefined): string[] =>
  maxMutants === undefined ? argv : [...argv, '--max-mutants', String(maxMutants)];

const planRun = async (
  root: string,
  configured: string[],
  request: MutationRequest,
): Promise<Plan> => {
  if (request.mode === 'audit') {
    const paths = readAuditPaths(request);

    return { argv: withLimit([...configured, 'audit', ...paths], request.maxMutants), base: null };
  }

  if (request.paths !== undefined) {
    throw new Error('The paths parameter belongs to audit mode, not changed mode.');
  }

  const { base } = await readCheckIdentity(root, configured, request.base);

  if (base === null) {
    throw new Error(
      'The origin remote has no default branch here, so pass a base: the ref or commit the change is based on.',
    );
  }

  return { argv: withLimit([...configured, 'changed', base], request.maxMutants), base };
};

const readReport = async (stdoutPath: string, logPath: string): Promise<MutationReport> => {
  const text = await readFile(stdoutPath, 'utf8');

  try {
    return parseMutationReport(text);
  } catch (error) {
    throw new Error(`${String(error instanceof Error ? error.message : error)} Log: ${logPath}`, {
      cause: error,
    });
  }
};

const settleRun = async (result: CheckResult): Promise<MutationVerdict> => {
  if (runWasStopped(result) || result.stdoutPath === undefined) {
    return { ...result, passed: false, status: undefined, survivors: [], unmutated: [] };
  }

  const report = await readReport(result.stdoutPath, result.logPath);

  return {
    ...result,
    passed: mutationPassed({
      ...result,
      status: report.status,
      hasUnmutated: report.unmutated.length > 0,
    }),
    status: report.status,
    ...(report.error === undefined ? {} : { error: report.error }),
    survivors: report.survivors,
    unmutated: report.unmutated,
  };
};

const describeMutant = (survivor: Survivor): string =>
  `  ${survivor.mutator}: ${survivor.original} => ${survivor.replacement}`;

const pluralize = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

const describeGroups = (label: string, survivors: Survivor[]): string[] => {
  if (survivors.length === 0) {
    return [];
  }

  const groups = new Map<string, Survivor[]>();

  for (const survivor of survivors) {
    const key = `${survivor.file}:${survivor.line}`;

    groups.set(key, [...(groups.get(key) ?? []), survivor]);
  }

  const heading = `${label}: ${pluralize(survivors.length, 'mutant')} on ${pluralize(groups.size, 'line')}.`;

  const lines = [heading];

  for (const [key, members] of groups) {
    lines.push(key);
    lines.push(...members.map((member) => describeMutant(member)));
  }

  return lines;
};

const describeStop = (result: MutationDetails): string => {
  if (result.reused) {
    return '';
  }

  if (result.idle) {
    return ' The command was stopped because it wrote no output to its log for the idle limit; it was hung.';
  }

  return result.exitCode === null ? ` It ended with signal ${result.signal ?? 'unknown'}.` : '';
};

const describeResult = (result: MutationDetails): string => {
  const verdict = result.passed ? 'passed' : 'failed';
  const status = result.status === undefined ? '' : ` (status ${result.status})`;
  const reuse = result.reused ? ' Reused the saved passing log for this unchanged state.' : '';

  const recordProblem =
    result.recordError === undefined ? '' : ` No reusable record was saved: ${result.recordError}`;

  const lines = [
    `Mutation check ${verdict}${status}.${describeStop(result)}${reuse}${recordProblem} Log: ${result.logPath}`,
  ];

  if (result.error !== undefined) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.unmutated.length > 0) {
    lines.push(`Not mutated: ${result.unmutated.join(', ')}`);
  }

  lines.push(
    ...describeGroups(
      'Covered survivors',
      result.survivors.filter((survivor) => survivor.covered),
    ),
    ...describeGroups(
      'No coverage',
      result.survivors.filter((survivor) => !survivor.covered),
    ),
  );

  return lines.join('\n');
};

// A saved report that is missing, does not parse, or does not judge as a pass disables reuse, so
// the script runs again.
const reuseSaved = async (
  root: string,
  identity: CheckIdentity,
): Promise<MutationDetails | undefined> => {
  const reused = await findReusedLog(root, identity, mutationChecksPath);

  if (reused === undefined) {
    return undefined;
  }

  try {
    const report = await readReport(stdoutPathOf(reused.logPath), reused.logPath);

    const passed = mutationPassed({
      ...reused,
      status: report.status,
      hasUnmutated: report.unmutated.length > 0,
    });

    if (!passed) {
      return undefined;
    }

    return {
      ...reused,
      status: report.status,
      ...(report.error === undefined ? {} : { error: report.error }),
      survivors: report.survivors,
      unmutated: report.unmutated,
    };
  } catch {
    return undefined;
  }
};

const toToolResult = (result: MutationDetails) => ({
  content: [{ type: 'text' as const, text: describeResult(result) }],
  details: result,
});

const execute = async (
  options: MutationCheckToolOptions,
  request: MutationRequest,
  signal: AbortSignal | undefined,
  notifyWaiting: (message: string) => void,
  context: Pick<ExtensionToolContext, 'cwd' | 'isProjectTrusted' | 'ui'>,
) => {
  const root = await findTauRoot(context.cwd, 'mutation_check');
  const agentDirectory = options.agentDirectory ?? getAgentDir();
  const repository = await readRepository(root);

  const location = {
    cwd: root,
    agentDirectory,
    projectTrusted: context.isProjectTrusted(),
  };

  const configured = readMutationArgv(location, context.ui);

  if (repository === undefined) {
    throw new Error(
      'This checkout has an origin remote that does not name an owner/name repository, so the mutation check has no lock to share with the full check.',
    );
  }

  const plan = await planRun(root, configured, request);
  const readIdentity = () => readMutationIdentity(root, plan.argv, plan.base);
  const identity = await readIdentity();
  const reusedBeforeWaiting = await reuseSaved(root, identity);

  if (reusedBeforeWaiting !== undefined) {
    return toToolResult(reusedBeforeWaiting);
  }

  const result = await withRepositoryLock(
    {
      root,
      agentDirectory,
      repository,
      signal,
      pollMilliseconds: options.pollMilliseconds ?? defaultPollMilliseconds,
      notifyWaiting,
    },
    async (recordCommandGroup) => {
      const current = await readIdentity();
      const reused = await reuseSaved(root, current);

      if (reused !== undefined) {
        return reused;
      }

      return runAndRecord(
        root,
        current,
        readIdentity,
        {
          signal,
          recordCommandGroup,
          idleLimitMilliseconds: options.idleLimitMilliseconds ?? defaultIdleLimitMilliseconds,
          checksPath: mutationChecksPath,
          separateStdout: true,
        },
        settleRun,
      );
    },
  );

  return toToolResult(result);
};

export const createMutationCheckTool = (
  options: MutationCheckToolOptions = {},
): ToolDefinition<typeof parameters, MutationDetails | undefined> =>
  defineTool({
    name: 'mutation_check',
    label: 'Mutation check',
    description: `Run the repository's mutation script and list the mutants that survived.
- The command is mutation.argv from .pi/tau.json in the repository, run without a shell in the checkout root. Tau reads the key only from that file, so the project must be trusted.
- Mode "changed" mutates the lines changed since base (optional; defaults to the origin remote's default branch, resolved to a commit). Mode "audit" mutates the whole files in paths (non-empty). Optional maxMutants (positive integer) caps the mutants.
- Shares the lock of full_check: a full check and a mutation check of one repository run one at a time across checkouts. When another checkout holds the lock, the tool sends an update that names it and waits. Cancelling stops the wait.
- Survivors are advice: a run with survivors passes (exit 2 in changed mode, exit 0 in audit mode). Fails on an error report, unmutated files, a nonzero exit other than 2 with survivors, a signal, and when the script writes no output to its log for 10 minutes.
- A passing result is saved with the head, base, command, and a fingerprint of the uncommitted changes. A later call for the same state returns that log and lists the same survivors without running the script, and says so. If the saved report is missing or does not parse, the script runs again. A failing run saves nothing for reuse.
- Saves the script's stderr as a log under .tau/checks/mutation in the checkout, apart from full check logs. The JSON report on stdout is saved beside it and parsed once.
- Returns pass or fail, the log path, the error text, the unmutated files, and the survivors: covered survivors apart from no-coverage mutants, grouped by <file>:<line> with one <mutator>: <original> => <replacement> line each. A failed check is a result, not an error.
- Errors: no Git checkout, no mutation.argv in .pi/tau.json, an invalid parameter, no base in changed mode when origin has no default branch, a command that cannot start, or a report that breaks the format.`,
    promptSnippet:
      'Run the repository mutation script, queued with the full check, and list the survivors.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, toolParameters, signal, onUpdate, context) {
      const notifyWaiting = (message: string) => {
        onUpdate?.({ content: [{ type: 'text', text: message }], details: undefined });
      };

      return execute(options, toolParameters, signal, notifyWaiting, context);
    },
  });
