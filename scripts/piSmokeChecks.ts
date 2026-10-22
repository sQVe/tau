import { isRecord } from '../src/schema.ts';

export interface GitFacts {
  commits: { subject: string; files: string[] }[];
}

interface ToolCall {
  id: string;
  parentId: string | undefined;
  toolName: string;
  isError: boolean;
  text: string;
  structuredOutput: string;
  details: unknown;
}

interface ToolEvents {
  calls: ToolCall[];
  scripts: Map<string, string>;
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

const structuredOutputOf = (result: unknown): string => {
  const structured = isRecord(result) ? result.structuredContent : undefined;
  const output = isRecord(structured) ? structured.output : undefined;

  return typeof output === 'string' ? output : '';
};

const toolCall = (event: unknown): ToolCall | undefined => {
  if (!isRecord(event) || event.type !== 'tool_execution_end') {
    return undefined;
  }

  if (typeof event.toolName !== 'string') {
    return undefined;
  }

  return {
    id: typeof event.toolCallId === 'string' ? event.toolCallId : '',
    parentId: typeof event.parentToolCallId === 'string' ? event.parentToolCallId : undefined,
    toolName: event.toolName,
    isError: event.isError === true,
    text: resultText(event.result),
    structuredOutput: structuredOutputOf(event.result),
    details: isRecord(event.result) ? event.result.details : undefined,
  };
};

const startedScript = (event: unknown): [string, string] | undefined => {
  if (!isRecord(event) || event.type !== 'tool_execution_start') {
    return undefined;
  }

  const code = isRecord(event.args) ? event.args.code : undefined;

  if (typeof event.toolCallId !== 'string' || typeof code !== 'string') {
    return undefined;
  }

  return [event.toolCallId, code];
};

const toolEvents = (lines: readonly string[]): ToolEvents => {
  const calls: ToolCall[] = [];
  const scripts = new Map<string, string>();

  for (const line of lines) {
    const event = parseEvent(line);
    const call = toolCall(event);
    const script = startedScript(event);

    if (call !== undefined) {
      calls.push(call);
    }

    if (script !== undefined) {
      scripts.set(script[0], script[1]);
    }
  }

  return { calls, scripts };
};

const describeTools = (calls: readonly ToolCall[]) =>
  calls.length === 0 ? 'none' : calls.map((call) => call.toolName).join(', ');

const freshnessOf = (details: unknown): string => {
  const freshness = isRecord(details) ? details.freshness : undefined;

  return typeof freshness === 'string' ? freshness : 'missing';
};

// Models sometimes add a read or a status check, which proves nothing about Tau, so only the
// checked tools must appear once each, in order. Nested calls, such as bash inside codemode, belong
// to their parent.
const sequenceFailures = (calls: readonly ToolCall[]): string[] => {
  const isCheckedCall = (call: ToolCall) =>
    call.parentId === undefined && expectedTools.includes(call.toolName);

  const actual = describeTools(calls.filter(isCheckedCall));
  const expected = expectedTools.join(', ');

  return actual === expected ? [] : [`tool calls: expected ${expected}, got ${actual}`];
};

const toolFailures = (calls: readonly ToolCall[]): string[] => {
  const failures: string[] = [];

  for (const toolName of expectedTools) {
    const named = calls.filter((call) => call.toolName === toolName);

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

  const freshness = freshnessOf(run.details);

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

const codemodeFailures = (events: ToolEvents): string[] => {
  const codemode = events.calls.find((call) => call.toolName === 'codemode' && !call.isError);

  if (codemode === undefined) {
    return [];
  }

  const failures: string[] = [];

  const nestedBash = events.calls.filter(
    (call) => call.toolName === 'bash' && call.parentId === codemode.id,
  );

  const nestedOutputs = nestedBash.filter(
    (call) =>
      !call.isError && `${call.structuredOutput}\n${call.text}`.includes(smokeCodemodeMarker),
  );

  if (nestedBash.length === 0) {
    failures.push(
      `codemode nested bash call: expected a bash end event with parent ${codemode.id}, got none`,
    );
  } else if (nestedOutputs.length === 0) {
    const actual = nestedBash.map((call) => call.structuredOutput || call.text).join(' | ');

    failures.push(
      `codemode nested bash output: expected ${smokeCodemodeMarker} without error, got ${JSON.stringify(actual.slice(0, excerptLength))}`,
    );
  }

  if (!codemode.text.includes(smokeCodemodeMarker)) {
    failures.push(
      `codemode bash marker: expected ${smokeCodemodeMarker} in the result, got ${JSON.stringify(codemode.text.slice(0, excerptLength))}`,
    );
  }

  const script = events.scripts.get(codemode.id);

  if (script === undefined) {
    failures.push(
      `codemode script: expected a start event for ${codemode.id} with args.code, got none`,
    );
  } else if (script.includes(smokeCodemodeMarker)) {
    failures.push(
      `codemode script: expected no literal ${smokeCodemodeMarker}, got ${JSON.stringify(script.slice(0, excerptLength))}`,
    );
  }

  return failures;
};

export const smokeFailures = (lines: readonly string[], git: GitFacts): string[] => {
  const events = toolEvents(lines);
  const { calls } = events;

  return [
    ...sequenceFailures(calls),
    ...toolFailures(calls),
    ...runFailures(calls),
    ...commitFailures(git),
    ...codemodeFailures(events),
  ];
};
