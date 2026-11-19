import { assistantCalls, parseEntries, text, toolResult } from '../src/improvement/transcript.ts';
import type { CallResult, Entry } from '../src/improvement/transcript.ts';
import type {
  JudgeOption,
  JudgeQuestion,
  PastAnswer,
  PastOutcome,
} from '../src/questionGate/questionGate.ts';
import { isRecord } from '../src/schema.ts';

export interface SessionLog {
  path: string;
  text: string;
}

export interface LoggedQuestion extends PastAnswer {
  // The root session of the file's parentSession chain, so copied entries keep one origin.
  session: string;
}

export interface SkippedQuestions {
  malformedLines: number;
  copiedEntries: number;
  declinedCalls: number;
  failedCalls: number;
  unansweredCalls: number;
  unmatchedResults: number;
  malformedAnswers: number;
  noRecommendation: number;
  multiSelect: number;
  preview: number;
}

export interface QuestionLog {
  questions: LoggedQuestion[];
  skipped: SkippedQuestions;
}

type SkipCounter = 'multiSelect' | 'preview' | 'noRecommendation';

type QuestionRead =
  | { kind: 'question'; question: JudgeQuestion; outcome: PastOutcome }
  | { kind: 'skip'; counter: SkipCounter }
  | { kind: 'malformed' };

interface ParsedLog {
  file: SessionLog;
  entries: Entry[];
  malformedLines: number;
}

interface RawOption {
  rawLabel: string;
  option: JudgeOption;
}

interface CallRecord {
  parameters: Entry | undefined;
}

interface ResultRecord {
  result: CallResult;
  toolName: string | undefined;
  session: string;
  time: number;
}

interface LogState {
  questions: LoggedQuestion[];
  skipped: SkippedQuestions;
  seen: Set<string>;
  calls: Map<string, CallRecord>;
  results: Map<string, ResultRecord>;
}

interface CompletedCall {
  parameters: Entry | undefined;
  result: CallResult;
  session: string;
  time: number;
}

interface QuestionShape {
  raw: Entry;
  question: string;
  optionEntries: Entry[];
  rawOptions: RawOption[];
  options: JudgeOption[];
}

const recommendedSuffix = ' (Recommended)';

const zeroSkipped = (): SkippedQuestions => ({
  malformedLines: 0,
  copiedEntries: 0,
  declinedCalls: 0,
  failedCalls: 0,
  unansweredCalls: 0,
  unmatchedResults: 0,
  malformedAnswers: 0,
  noRecommendation: 0,
  multiSelect: 0,
  preview: 0,
});

// Forks and follow-ups copy entries with their IDs and timestamps, so each copy counts once.
const copyKey = (entry: Entry) => `${text(entry.id) ?? ''}\0${text(entry.timestamp) ?? ''}`;

const stripRecommendation = (label: string) =>
  label.endsWith(recommendedSuffix) ? label.slice(0, -recommendedSuffix.length) : label;

const readOption = (raw: Entry, rawLabel: string): RawOption => {
  const label = stripRecommendation(rawLabel);

  return {
    rawLabel,
    option: {
      label,
      description: text(raw.description) ?? '',
      recommended: raw.recommended === true || rawLabel !== label,
    },
  };
};

const readOptions = (optionEntries: readonly Entry[]): RawOption[] | undefined => {
  const options: RawOption[] = [];

  for (const raw of optionEntries) {
    const label = text(raw.label);

    if (label === undefined) {
      return undefined;
    }

    options.push(readOption(raw, label));
  }

  return options;
};

const hasPreview = (raw: Entry, optionEntries: readonly Entry[]) =>
  text(raw.preview) !== undefined ||
  optionEntries.some((option) => text(option.preview) !== undefined);

const isClosed = (details: Entry) => details.kind === 'declined' || details.cancelled === true;

const isDeclined = (details: unknown) => {
  if (!isRecord(details)) {
    return false;
  }

  return isClosed(details);
};

const isQuestionDetails = (details: unknown) => {
  if (!isRecord(details)) {
    return false;
  }

  const answered = Array.isArray(details.answers);

  return answered || isClosed(details);
};

// Older logs lack the result's tool name, so only their details can identify a question result.
const isQuestionResult = (toolName: string | undefined, details: unknown) =>
  toolName === undefined ? isQuestionDetails(details) : toolName === 'ask_user_question';

const isIndexedRow = (row: Entry) => typeof row.questionIndex === 'number';

const answerRow = (answers: readonly unknown[], index: number): Entry | undefined => {
  const indexed = answers.find(
    (row) => isRecord(row) && isIndexedRow(row) && row.questionIndex === index,
  );

  if (isRecord(indexed)) {
    return indexed;
  }

  const positional = answers[index];

  return isRecord(positional) && !isIndexedRow(positional) ? positional : undefined;
};

const outcomeForLabel = (
  rawValue: string,
  options: readonly RawOption[],
): PastOutcome | undefined => {
  const found = options.find((candidate) => candidate.rawLabel === rawValue);

  if (found === undefined) {
    return undefined;
  }

  return found.option.recommended
    ? { kind: 'recommended' }
    : { kind: 'otherOption', label: found.option.label };
};

const typedOutcome = (answer: string | undefined): PastOutcome | undefined =>
  answer === undefined ? undefined : { kind: 'typed', text: answer };

const indexedOutcome = (row: Entry, options: readonly RawOption[]): PastOutcome | undefined => {
  const kind = text(row.kind);
  const answer = text(row.answer);

  if (kind === 'custom') {
    return typedOutcome(answer);
  }

  return kind === 'option' && answer !== undefined ? outcomeForLabel(answer, options) : undefined;
};

const selectedValues = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  return value.every((item): item is string => typeof item === 'string') ? value : undefined;
};

const selectedOutcome = (row: Entry, options: readonly RawOption[]): PastOutcome | undefined => {
  const selected = selectedValues(row.selected);
  const typed = row.typed;
  const typedValid = typed === undefined || typeof typed === 'boolean';

  if (selected === undefined || !typedValid) {
    return undefined;
  }

  const answer = selected.join(', ');

  if (typed === true) {
    return { kind: 'typed', text: answer };
  }

  const outcome = outcomeForLabel(answer, options);

  return typed === false ? outcome : (outcome ?? { kind: 'typed', text: answer });
};

const readOutcome = (row: Entry, options: readonly RawOption[]): PastOutcome | undefined =>
  text(row.kind) === undefined ? selectedOutcome(row, options) : indexedOutcome(row, options);

const skipReason = (
  raw: Entry,
  optionEntries: readonly Entry[],
  options: readonly JudgeOption[],
): SkipCounter | undefined => {
  if (raw.multiSelect === true) {
    return 'multiSelect';
  }

  if (hasPreview(raw, optionEntries)) {
    return 'preview';
  }

  const recommended = options.filter((option) => option.recommended);

  return recommended.length === 1 ? undefined : 'noRecommendation';
};

const questionShape = (raw: unknown): QuestionShape | undefined => {
  if (!isRecord(raw)) {
    return undefined;
  }

  const question = text(raw.question);
  const optionEntries = Array.isArray(raw.options) ? raw.options.filter(isRecord) : undefined;
  const rawOptions = optionEntries === undefined ? undefined : readOptions(optionEntries);

  if (question === undefined || optionEntries === undefined || rawOptions === undefined) {
    return undefined;
  }

  return {
    raw,
    question,
    optionEntries,
    rawOptions,
    options: rawOptions.map((entry) => entry.option),
  };
};

const readQuestion = (raw: unknown, index: number, answers: readonly unknown[]): QuestionRead => {
  const shape = questionShape(raw);

  if (shape === undefined) {
    return { kind: 'malformed' };
  }

  const skip = skipReason(shape.raw, shape.optionEntries, shape.options);

  if (skip !== undefined) {
    return { kind: 'skip', counter: skip };
  }

  const row = answerRow(answers, index);
  const outcome = row === undefined ? undefined : readOutcome(row, shape.rawOptions);

  if (outcome === undefined) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'question',
    question: {
      question: shape.question,
      problem: text(shape.raw.problem) ?? text(shape.raw.context) ?? '',
      impact: text(shape.raw.impact) ?? '',
      options: shape.options,
    },
    outcome,
  };
};

const readCall = (state: LogState, call: CompletedCall) => {
  const details = call.result.details;

  if (isDeclined(details)) {
    state.skipped.declinedCalls += 1;

    return;
  }

  const answers = isRecord(details) && Array.isArray(details.answers) ? details.answers : undefined;

  if (call.result.error !== undefined || answers === undefined || answers.length === 0) {
    state.skipped.failedCalls += 1;

    return;
  }

  const questions =
    isRecord(call.parameters) && Array.isArray(call.parameters.questions)
      ? call.parameters.questions
      : [];

  for (const [index, raw] of questions.entries()) {
    const read = readQuestion(raw, index, answers);

    if (read.kind === 'skip') {
      state.skipped[read.counter] += 1;
    } else if (read.kind === 'malformed') {
      state.skipped.malformedAnswers += 1;
    } else {
      state.questions.push({
        time: call.time,
        session: call.session,
        question: read.question,
        outcome: read.outcome,
      });
    }
  }
};

const addCall = (state: LogState, message: Entry) => {
  for (const called of assistantCalls(message).calls) {
    if (called.tool === 'ask_user_question') {
      state.calls.set(called.callId, { parameters: called.arguments });
    }
  }
};

const addResult = (state: LogState, message: Entry, session: string, time: number) => {
  const { callId, result } = toolResult(message);
  const toolName = text(message.toolName);

  state.results.set(callId, { result, toolName, session, time });
};

const collectEntry = (state: LogState, origin: string, entry: Entry) => {
  const time = Date.parse(text(entry.timestamp) ?? '');

  if (Number.isNaN(time)) {
    state.skipped.malformedLines += 1;

    return;
  }

  const key = copyKey(entry);

  if (state.seen.has(key)) {
    state.skipped.copiedEntries += 1;

    return;
  }

  state.seen.add(key);

  const message = entry.message;

  if (!isRecord(message)) {
    return;
  }

  if (message.role === 'assistant') {
    addCall(state, message);
  } else if (message.role === 'toolResult') {
    addResult(state, message, origin, time);
  }
};

const collectEntries = (state: LogState, origin: string, entries: readonly Entry[]) => {
  for (const entry of entries) {
    collectEntry(state, origin, entry);
  }
};

const parentSessions = (logs: readonly ParsedLog[]): Map<string, string> => {
  const parents = new Map<string, string>();

  for (const { file, entries } of logs) {
    const header = entries.find((entry) => entry.type === 'session');
    const parent = header === undefined ? undefined : text(header.parentSession);

    if (parent !== undefined && parent !== '') {
      parents.set(file.path, parent);
    }
  }

  return parents;
};

const originSession = (path: string, parents: ReadonlyMap<string, string>): string => {
  const visited = new Set<string>();
  let current = path;

  while (!visited.has(current)) {
    visited.add(current);

    const parent = parents.get(current);

    if (parent === undefined) {
      return current;
    }

    current = parent;
  }

  return current;
};

const joinCalls = (state: LogState) => {
  for (const [callId, call] of state.calls) {
    const result = state.results.get(callId);

    if (result === undefined) {
      state.skipped.unansweredCalls += 1;
    } else {
      state.results.delete(callId);

      readCall(state, {
        parameters: call.parameters,
        result: result.result,
        session: result.session,
        time: result.time,
      });
    }
  }

  for (const result of state.results.values()) {
    if (isQuestionResult(result.toolName, result.result.details)) {
      state.skipped.unmatchedResults += 1;
    }
  }
};

export const readLoggedQuestions = (files: readonly SessionLog[]): QuestionLog => {
  const logs: ParsedLog[] = files.map((file) => ({ file, ...parseEntries(file.text) }));
  const parents = parentSessions(logs);

  const state: LogState = {
    questions: [],
    skipped: zeroSkipped(),
    seen: new Set(),
    calls: new Map(),
    results: new Map(),
  };

  for (const { file, entries, malformedLines } of logs) {
    state.skipped.malformedLines += malformedLines;
    collectEntries(state, originSession(file.path, parents), entries);
  }

  joinCalls(state);

  return {
    questions: state.questions.toSorted((left, right) => left.time - right.time),
    skipped: state.skipped,
  };
};
