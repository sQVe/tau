import { isRecord } from '../src/schema.ts';

export interface SessionArguments {
  cwd?: string | undefined;
  prompt?: string | undefined;
  'prompt-file'?: string | undefined;
  timeout?: string | undefined;
}

export type PromptSource = { kind: 'text'; text: string } | { kind: 'file'; path: string };

export interface SessionOptions {
  cwd: string;
  prompt: PromptSource;
  timeoutSeconds: number;
}

export interface LocalPackage {
  source: string;
  realPath: string;
  name: string | undefined;
}

export interface OpenWorker {
  assignmentId: string;
  address: string;
}

export type SessionStep =
  | { kind: 'running' }
  | { kind: 'ended' }
  | { kind: 'failed'; cause: string };

export type AssistantStop =
  | { kind: 'none' }
  | { kind: 'stopped' }
  | { kind: 'error'; text: string };

export interface SessionState {
  step: SessionStep;
  lastAssistantStop: AssistantStop;
  launched: OpenWorker[];
  closedAssignments: string[];
}

export type SessionEnd =
  | { kind: 'ended' }
  | { kind: 'failed'; cause: string }
  | { kind: 'pi-exit'; code: number | null }
  | { kind: 'timeout'; seconds: number }
  | { kind: 'signal'; signal: string };

const defaultTimeoutSeconds = 1800;
const remotePackagePrefix = /^(?:npm:|git:|git@|https?:\/\/|ssh:\/\/)/;
const workerMessageTypes = new Set(['tau-worker-report', 'tau-worker-ended']);
const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);
const assignmentDirectory = /([^/]+)\/[^/]+$/;

const timeoutSeconds = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return defaultTimeoutSeconds;
  }

  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
};

const promptSource = (values: SessionArguments): PromptSource | string => {
  const text = values.prompt;
  const path = values['prompt-file'];

  if (text !== undefined && path !== undefined) {
    return 'Give --prompt or --prompt-file, not both.';
  }

  if (text !== undefined) {
    return { kind: 'text', text };
  }

  if (path !== undefined) {
    return { kind: 'file', path };
  }

  return 'A prompt is required: give --prompt or --prompt-file.';
};

export const sessionOptions = (values: SessionArguments): SessionOptions | string => {
  if (values.cwd === undefined) {
    return '--cwd is required.';
  }

  const prompt = promptSource(values);

  if (typeof prompt === 'string') {
    return prompt;
  }

  const seconds = timeoutSeconds(values.timeout);

  if (seconds === undefined) {
    return `--timeout must be a positive integer of seconds, got "${values.timeout}".`;
  }

  return { cwd: values.cwd, prompt, timeoutSeconds: seconds };
};

export const piArguments = (sessionDirectory: string, model: string | undefined): string[] => {
  const modelArguments = model === undefined ? [] : ['--model', model];

  return ['--mode', 'rpc', '--approve', '--session-dir', sessionDirectory, ...modelArguments];
};

const packageSource = (entry: unknown): string | undefined => {
  if (typeof entry === 'string') {
    return entry;
  }

  return isRecord(entry) && typeof entry.source === 'string' ? entry.source : undefined;
};

export const localPackageSources = (settings: unknown): string[] => {
  const packages = isRecord(settings) ? settings.packages : undefined;

  if (!Array.isArray(packages)) {
    return [];
  }

  return packages
    .flatMap((entry) => packageSource(entry) ?? [])
    .filter((source) => !remotePackagePrefix.test(source));
};

export const projectSettings = (
  checkout: { realPath: string; name: string },
  userPackages: LocalPackage[],
): string | undefined => {
  if (userPackages.some((entry) => entry.realPath === checkout.realPath)) {
    return undefined;
  }

  const unloaded = userPackages
    .filter((entry) => entry.name === checkout.name)
    .map((entry) => ({
      source: entry.source,
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    }));

  return `${JSON.stringify({ packages: [checkout.realPath, ...unloaded] }, undefined, 2)}\n`;
};

export const startState: SessionState = {
  step: { kind: 'running' },
  launched: [],
  closedAssignments: [],
  lastAssistantStop: { kind: 'none' },
};

export const openWorkers = (state: SessionState): OpenWorker[] =>
  state.launched.filter((worker) => !state.closedAssignments.includes(worker.assignmentId));

const launchedWorker = (record: Record<string, unknown>): OpenWorker | undefined => {
  const succeeded = record.toolName === 'subagent' && record.isError === false;
  const details = isRecord(record.result) ? record.result.details : undefined;

  if (!succeeded || !isRecord(details)) {
    return undefined;
  }

  const labels = isRecord(details.labels) ? details.labels : {};
  const assignment = labels['tau.assignment'];
  const { address } = details;

  if (typeof assignment !== 'string' || typeof address !== 'string') {
    return undefined;
  }

  return { assignmentId: assignmentDirectory.exec(assignment)?.[1] ?? assignment, address };
};

const closedAssignment = (record: Record<string, unknown>): string | undefined => {
  const message = isRecord(record.message) ? record.message : {};
  const isWorkerMessage = workerMessageTypes.has(String(message.customType));
  const details = isRecord(message.details) ? message.details : {};

  if (message.role !== 'custom' || !isWorkerMessage) {
    return undefined;
  }

  return typeof details.assignmentId === 'string' ? details.assignmentId : undefined;
};

const promptFailure = (record: Record<string, unknown>): string | undefined => {
  if (record.command !== 'prompt' || record.success !== false) {
    return undefined;
  }

  const error = typeof record.error === 'string' ? record.error : 'no error text';

  return `Pi refused the prompt: ${error}`;
};

const assistantStop = (record: Record<string, unknown>): AssistantStop | undefined => {
  const message = isRecord(record.message) ? record.message : {};

  if (message.role !== 'assistant') {
    return undefined;
  }

  if (message.stopReason !== 'error') {
    return { kind: 'stopped' };
  }

  const text = typeof message.errorMessage === 'string' ? message.errorMessage : 'no error text';

  return { kind: 'error', text };
};

const settledStep = (state: SessionState, record: Record<string, unknown>): SessionStep => {
  if (openWorkers(state).length > 0) {
    return { kind: 'running' };
  }

  if (record.aborted === true) {
    return { kind: 'failed', cause: 'The run was aborted.' };
  }

  const stop = state.lastAssistantStop;

  if (stop.kind === 'error') {
    return {
      kind: 'failed',
      cause: `The last assistant message ended with an error: ${stop.text}`,
    };
  }

  return { kind: 'ended' };
};

export const nextSessionState = (state: SessionState, record: unknown): SessionState => {
  if (!isRecord(record) || state.step.kind !== 'running') {
    return state;
  }

  if (record.type === 'tool_execution_end') {
    const worker = launchedWorker(record);

    return worker === undefined ? state : { ...state, launched: [...state.launched, worker] };
  }

  if (record.type === 'message_start') {
    const assignmentId = closedAssignment(record);

    return assignmentId === undefined
      ? state
      : { ...state, closedAssignments: [...state.closedAssignments, assignmentId] };
  }

  if (record.type === 'response') {
    const cause = promptFailure(record);

    return cause === undefined ? state : { ...state, step: { kind: 'failed', cause } };
  }

  if (record.type === 'message_end') {
    const lastAssistantStop = assistantStop(record);

    return lastAssistantStop === undefined ? state : { ...state, lastAssistantStop };
  }

  return record.type === 'agent_settled' ? { ...state, step: settledStep(state, record) } : state;
};

export const dialogResponse = (record: unknown): string | undefined => {
  if (!isRecord(record) || record.type !== 'extension_ui_request') {
    return undefined;
  }

  if (!dialogMethods.has(String(record.method))) {
    return undefined;
  }

  return JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true });
};

const failureCause = (end: Exclude<SessionEnd, { kind: 'ended' }>): string => {
  if (end.kind === 'failed') {
    return end.cause;
  }

  if (end.kind === 'pi-exit') {
    return `Pi exited with code ${end.code} before the session ended.`;
  }

  if (end.kind === 'timeout') {
    return `The session did not end within ${end.seconds} seconds.`;
  }

  return `Stopped by ${end.signal}.`;
};

export const sessionExit = (
  end: SessionEnd,
  open: OpenWorker[],
  eventLog: string,
): { code: number; output: string[]; errors: string[] } => {
  const output = [`Event log: ${eventLog}`];

  if (end.kind === 'ended') {
    return { code: 0, output, errors: [] };
  }

  const keepsWorkers = end.kind === 'timeout' || end.kind === 'signal';
  const stillRunning = keepsWorkers ? open : [];

  const workerLines = stillRunning.map(
    (worker) => `Worker ${worker.assignmentId} still runs at hc address ${worker.address}.`,
  );

  return { code: 1, output, errors: [`FAIL ${failureCause(end)}`, ...workerLines] };
};
