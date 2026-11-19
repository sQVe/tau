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

interface LogState {
  questions: LoggedQuestion[];
  skipped: SkippedQuestions;
  seen: Set<string>;
  pending: Map<string, Entry | undefined>;
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
  rawOptions: Entry[];
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

const readOption = (raw: Entry, label: string): JudgeOption => {
  const stripped = stripRecommendation(label);

  return {
    label: stripped,
    description: text(raw.description) ?? '',
    recommended: raw.recommended === true || label !== stripped,
  };
};

const readOptions = (rawOptions: readonly Entry[]): JudgeOption[] | undefined => {
  const options: JudgeOption[] = [];

  for (const raw of rawOptions) {
    const label = text(raw.label);

    if (label === undefined) {
      return undefined;
    }

    options.push(readOption(raw, label));
  }

  return options;
};

const hasPreview = (raw: Entry, rawOptions: readonly Entry[]) =>
  text(raw.preview) !== undefined ||
  rawOptions.some((option) => text(option.preview) !== undefined);

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

const isIndexedRow = (row: Entry) => typeof row.questionIndex === 'number';

const answerRow = (answers: readonly unknown[], index: number): Entry | undefined => {
  const rows = answers.filter(isRecord);
  const indexed = rows.find((row) => isIndexedRow(row) && row.questionIndex === index);

  if (indexed !== undefined) {
    return indexed;
  }

  return rows.filter((row) => !isIndexedRow(row))[index];
};

const outcomeForLabel = (
  value: string,
  options: readonly JudgeOption[],
): PastOutcome | undefined => {
  const label = stripRecommendation(value);
  const option = options.find((candidate) => candidate.label === label);

  if (option === undefined) {
    return undefined;
  }

  return option.recommended
    ? { kind: 'recommended' }
    : { kind: 'otherOption', label: option.label };
};

const typedOutcome = (answer: string | undefined): PastOutcome | undefined =>
  answer === undefined ? undefined : { kind: 'typed', text: answer };

const indexedOutcome = (row: Entry, options: readonly JudgeOption[]): PastOutcome | undefined => {
  const kind = text(row.kind);
  const answer = text(row.answer);

  if (kind === 'custom') {
    return typedOutcome(answer);
  }

  return kind === 'option' && answer !== undefined ? outcomeForLabel(answer, options) : undefined;
};

const selectedOutcome = (row: Entry, options: readonly JudgeOption[]): PastOutcome | undefined => {
  if (!Array.isArray(row.selected)) {
    return undefined;
  }

  const selected = row.selected.filter((value): value is string => typeof value === 'string');

  if (selected.length === 0) {
    return undefined;
  }

  const answer = selected.join(', ');

  if (row.typed === true) {
    return { kind: 'typed', text: answer };
  }

  const outcome = outcomeForLabel(answer, options);

  return row.typed === false ? outcome : (outcome ?? { kind: 'typed', text: answer });
};

const readOutcome = (row: Entry, options: readonly JudgeOption[]): PastOutcome | undefined =>
  text(row.kind) === undefined ? selectedOutcome(row, options) : indexedOutcome(row, options);

const skipReason = (
  raw: Entry,
  rawOptions: readonly Entry[],
  options: readonly JudgeOption[],
): SkipCounter | undefined => {
  if (raw.multiSelect === true) {
    return 'multiSelect';
  }

  if (hasPreview(raw, rawOptions)) {
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
  const rawOptions = Array.isArray(raw.options) ? raw.options.filter(isRecord) : undefined;
  const options = rawOptions === undefined ? undefined : readOptions(rawOptions);

  if (question === undefined || rawOptions === undefined || options === undefined) {
    return undefined;
  }

  return { raw, question, rawOptions, options };
};

const readQuestion = (raw: unknown, index: number, answers: readonly unknown[]): QuestionRead => {
  const shape = questionShape(raw);

  if (shape === undefined) {
    return { kind: 'malformed' };
  }

  const skip = skipReason(shape.raw, shape.rawOptions, shape.options);

  if (skip !== undefined) {
    return { kind: 'skip', counter: skip };
  }

  const row = answerRow(answers, index);
  const outcome = row === undefined ? undefined : readOutcome(row, shape.options);

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
      state.pending.set(called.callId, called.arguments);
    }
  }
};

const addResult = (state: LogState, message: Entry, session: string, time: number) => {
  const { callId, result } = toolResult(message);

  if (!state.pending.has(callId)) {
    if (isQuestionDetails(result.details)) {
      state.skipped.unmatchedResults += 1;
    }

    return;
  }

  const parameters = state.pending.get(callId);

  state.pending.delete(callId);
  readCall(state, { parameters, result, session, time });
};

const readEntry = (state: LogState, session: string, entry: Entry) => {
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
    addResult(state, message, session, time);
  }
};

const readSessionLog = (state: LogState, file: SessionLog) => {
  const { entries, malformedLines } = parseEntries(file.text);

  state.skipped.malformedLines += malformedLines;

  for (const entry of entries) {
    readEntry(state, file.path, entry);
  }
};

export const readLoggedQuestions = (files: readonly SessionLog[]): QuestionLog => {
  const state: LogState = {
    questions: [],
    skipped: zeroSkipped(),
    seen: new Set(),
    pending: new Map(),
  };

  for (const file of files) {
    readSessionLog(state, file);
  }

  state.skipped.unansweredCalls = state.pending.size;

  return {
    questions: state.questions.toSorted((left, right) => left.time - right.time),
    skipped: state.skipped,
  };
};
