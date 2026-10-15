export interface GitFacts {
  commits: { subject: string; files: string[] }[];
}

interface ToolCall {
  toolName: string;
  isError: boolean;
  text: string;
  details: unknown;
}

const excerptLength = 300;

export const smokeCommitSubject = 'chore: smoke commit';
export const smokeCommitFile = 'src/answer.ts';
export const smokeCodemodeMarker = 'tau-smoke-7431';
export const smokeTestName = 'answer returns 41';

const expectedTools = ['run_tests', 'edit', 'commit', 'codemode'];

const parseEvent = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const resultText = (result: unknown): string => {
  const content = isRecord(result) ? result.content : undefined;

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(isRecord)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
};

const toolCall = (event: unknown): ToolCall | undefined => {
  if (!isRecord(event) || event.type !== 'tool_execution_end') {
    return undefined;
  }

  if (typeof event.toolName !== 'string') {
    return undefined;
  }

  return {
    toolName: event.toolName,
    isError: event.isError === true,
    text: resultText(event.result),
    details: isRecord(event.result) ? event.result.details : undefined,
  };
};

const toolCalls = (lines: readonly string[]): ToolCall[] =>
  lines.flatMap((line) => {
    const call = toolCall(parseEvent(line));

    return call === undefined ? [] : [call];
  });

const describeTools = (calls: readonly ToolCall[]) =>
  calls.length === 0 ? 'none' : calls.map((call) => call.toolName).join(', ');

const freshnessOf = (text: string): string =>
  /·\s*(fresh|stale|unknown)\b/.exec(text)?.[1] ?? 'none';

const toolFailures = (calls: readonly ToolCall[]): string[] => {
  const failures: string[] = [];

  for (const toolName of expectedTools) {
    const named = calls.filter((call) => call.toolName === toolName);

    if (named.length === 0) {
      failures.push(
        `${toolName} tool call: expected at least one call, got none (calls: ${describeTools(calls)})`,
      );
    }

    for (const call of named.filter((candidate) => candidate.isError)) {
      failures.push(
        `${toolName} tool call: expected no error, got error: ${call.text.slice(0, excerptLength)}`,
      );
    }
  }

  return failures;
};

const runPassed = (details: unknown): boolean => {
  if (!isRecord(details) || !isRecord(details.report) || details.report.kind !== 'pass') {
    return false;
  }

  const tests = Array.isArray(details.report.tests) ? details.report.tests : [];

  return tests.some(
    (test) => isRecord(test) && test.fullname === smokeTestName && test.status === 'passed',
  );
};

const describeRun = (details: unknown): string => {
  if (!isRecord(details) || !isRecord(details.report)) {
    return 'no runner result';
  }

  const tests = Array.isArray(details.report.tests) ? details.report.tests.length : 0;

  return `${String(details.report.kind)} with ${tests} listed tests`;
};

const runFailures = (calls: readonly ToolCall[]): string[] => {
  const failures: string[] = [];
  const runIndex = calls.findIndex((call) => call.toolName === 'run_tests' && !call.isError);
  const run = calls[runIndex];

  if (run === undefined) {
    return failures;
  }

  if (!runPassed(run.details)) {
    failures.push(
      `run_tests result: expected pass with "${smokeTestName}" passed, got ${describeRun(run.details)}`,
    );
  }

  const freshness = freshnessOf(run.text);

  if (freshness !== 'fresh') {
    failures.push(`run_tests freshness after a run: expected fresh, got ${freshness}`);

    return failures;
  }

  const edit = calls.slice(runIndex + 1).find((call) => call.toolName === 'edit' && !call.isError);

  if (edit?.text.includes('Test results are stale') !== true) {
    failures.push(
      'run_tests freshness after an edit: expected stale hint on an edit result after the fresh run, got none',
    );
  }

  return failures;
};

const commitFailures = (git: GitFacts): string[] => {
  const commit = git.commits.find((candidate) => candidate.subject === smokeCommitSubject);

  if (commit === undefined) {
    const subjects = git.commits.map((candidate) => candidate.subject).join(' | ') || 'none';

    return [
      `commit in the scratch repository: expected subject "${smokeCommitSubject}", got ${subjects}`,
    ];
  }

  const actual = commit.files.join(', ') || 'none';

  if (actual !== smokeCommitFile) {
    return [`commit files in the scratch repository: expected ${smokeCommitFile}, got ${actual}`];
  }

  return [];
};

const nestedBashRan = (details: unknown): boolean => {
  const nested = isRecord(details) && Array.isArray(details.calls) ? details.calls : [];

  return nested.some((call) => isRecord(call) && call.name === 'bash' && call.status === 'ok');
};

const codemodeFailures = (calls: readonly ToolCall[]): string[] => {
  const codemode = calls.find((call) => call.toolName === 'codemode' && !call.isError);

  if (codemode === undefined) {
    return [];
  }

  if (!nestedBashRan(codemode.details)) {
    return ['codemode nested bash call: expected one bash call with status ok, got none'];
  }

  if (codemode.text.includes(smokeCodemodeMarker)) {
    return [];
  }

  return [
    `codemode bash marker: expected ${smokeCodemodeMarker} in the result, got ${JSON.stringify(codemode.text.slice(0, excerptLength))}`,
  ];
};

export const smokeFailures = (lines: readonly string[], git: GitFacts): string[] => {
  const calls = toolCalls(lines);

  return [
    ...toolFailures(calls),
    ...runFailures(calls),
    ...commitFailures(git),
    ...codemodeFailures(calls),
  ];
};
