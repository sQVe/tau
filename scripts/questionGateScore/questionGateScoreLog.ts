import {
  assistantCalls,
  copyKey,
  parseEntries,
  text,
  toolResult,
} from '../../src/improvement/transcript.ts';
import type { CallResult, Entry } from '../../src/improvement/transcript.ts';
import type {
  JudgeOption,
  JudgeQuestion,
  PastAnswer,
  PastOutcome,
} from '../../src/questionGate/questionGate.ts';
import { isRecord } from '../../src/schema.ts';

export interface SessionLog {
  path: string;
  text: string;
}

export interface LoggedQuestion extends PastAnswer {
  session: string;
  callTime: number;
}

export interface SkippedQuestions {
  malformedLines: number;
  copiedEntries: number;
  declinedCalls: number;
  failedCalls: number;
  unansweredCalls: number;
  unmatchedResults: number;
  ambiguousEntries: number;
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
  path: string;
  malformedLines: number;
  parent: string | undefined;
}

interface EntryPlace {
  file: string;
  index: number;
}

interface EntryRecord {
  entry: Entry;
  time: number;
  places: EntryPlace[];
}

interface CallOccurrence {
  id: number;
  callId: string;
  parameters: Entry | undefined;
  places: EntryPlace[];
  time: number;
}

interface ResultOccurrence {
  id: number;
  callId: string;
  result: CallResult;
  toolName: string | undefined;
  places: EntryPlace[];
  session: string;
  time: number;
}

interface Occurrences {
  calls: CallOccurrence[];
  results: ResultOccurrence[];
}

interface OccurrencePair {
  call: CallOccurrence;
  result: ResultOccurrence;
}

interface Pairing {
  pairs: OccurrencePair[];
  unanswered: CallOccurrence[];
  unmatched: ResultOccurrence[];
  ambiguous: number;
}

interface LogState {
  questions: LoggedQuestion[];
  skipped: SkippedQuestions;
  entries: Map<string, EntryRecord>;
  firstFiles: Map<string, string>;
  sharedFiles: [string, string][];
}

interface CompletedCall {
  parameters: Entry | undefined;
  result: CallResult;
  session: string;
  time: number;
  callTime: number;
}

interface QuestionShape {
  raw: Entry;
  question: string;
  optionEntries: Entry[];
  rawOptions: RawOption[];
  options: JudgeOption[];
}

interface RawOption {
  rawLabel: string;
  option: JudgeOption;
}

type ScanEvent =
  | { index: number; kind: 'call'; call: CallOccurrence }
  | { index: number; kind: 'result'; result: ResultOccurrence };

export interface QuestionLogReader {
  add: (file: SessionLog) => void;
  finish: () => QuestionLog;
}

const recommendedSuffix = ' (Recommended)';

const zeroSkipped = (): SkippedQuestions => ({
  malformedLines: 0,
  copiedEntries: 0,
  declinedCalls: 0,
  failedCalls: 0,
  unansweredCalls: 0,
  unmatchedResults: 0,
  ambiguousEntries: 0,
  malformedAnswers: 0,
  noRecommendation: 0,
  multiSelect: 0,
  preview: 0,
});

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

const isQuestionResult = (toolName: string | undefined, details: unknown) =>
  toolName === undefined ? isQuestionDetails(details) : toolName === 'ask_user_question';

const isQuestionEntry = (entry: Entry): boolean => {
  const message = entry.message;

  if (!isRecord(message)) {
    return false;
  }

  if (message.role === 'assistant') {
    return assistantCalls(message).calls.some((called) => called.tool === 'ask_user_question');
  }

  if (message.role === 'toolResult') {
    const { result } = toolResult(message);

    return isQuestionResult(text(message.toolName), result.details);
  }

  return false;
};

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
        callTime: call.callTime,
        session: call.session,
        question: read.question,
        outcome: read.outcome,
      });
    }
  }
};

const sessionParent = (entries: readonly Entry[]): string | undefined => {
  const header = entries.find((entry) => entry.type === 'session');
  const parent = text(header?.parentSession);

  return parent === undefined || parent === '' ? undefined : parent;
};

const findGroup = (groups: Map<string, string>, node: string): string => {
  const parent = groups.get(node);

  if (parent === undefined || parent === node) {
    return node;
  }

  const root = findGroup(groups, parent);

  groups.set(node, root);

  return root;
};

const unionGroups = (groups: Map<string, string>, left: string, right: string) => {
  const leftRoot = findGroup(groups, left);
  const rightRoot = findGroup(groups, right);

  if (leftRoot !== rightRoot) {
    groups.set(leftRoot, rightRoot);
  }
};

// A session group holds every file linked by a parentSession path or by a shared entry.
const sessionKeys = (
  logs: readonly ParsedLog[],
  sharedFiles: readonly (readonly [string, string])[],
): Map<string, string> => {
  const groups = new Map<string, string>();
  const nodes = new Set<string>();

  for (const { path, parent } of logs) {
    nodes.add(path);

    if (parent !== undefined) {
      nodes.add(parent);
      unionGroups(groups, path, parent);
    }
  }

  for (const [first, copy] of sharedFiles) {
    unionGroups(groups, first, copy);
  }

  const minimum = new Map<string, string>();

  for (const node of nodes) {
    const root = findGroup(groups, node);
    const current = minimum.get(root);

    if (current === undefined || node < current) {
      minimum.set(root, node);
    }
  }

  const keys = new Map<string, string>();

  for (const { path } of logs) {
    const root = findGroup(groups, path);

    keys.set(path, minimum.get(root) ?? path);
  }

  return keys;
};

const readOccurrences = (state: LogState, keys: ReadonlyMap<string, string>): Occurrences => {
  const calls: CallOccurrence[] = [];
  const results: ResultOccurrence[] = [];
  let nextId = 0;

  for (const { entry, time, places } of state.entries.values()) {
    const message = entry.message;

    if (!isRecord(message)) {
      continue;
    }

    const [firstPlace] = places;
    const session = firstPlace === undefined ? '' : (keys.get(firstPlace.file) ?? firstPlace.file);

    if (message.role === 'assistant') {
      const asked = assistantCalls(message).calls.filter(
        (called) => called.tool === 'ask_user_question',
      );

      for (const called of asked) {
        nextId += 1;

        calls.push({
          id: nextId,
          callId: called.callId,
          parameters: called.arguments,
          places,
          time,
        });
      }
    } else if (message.role === 'toolResult') {
      const { callId, result } = toolResult(message);

      nextId += 1;

      results.push({
        id: nextId,
        callId,
        result,
        toolName: text(message.toolName),
        places,
        session,
        time,
      });
    }
  }

  return { calls, results };
};

const groupByCallId = <Record extends { callId: string }>(
  records: readonly Record[],
): Map<string, Record[]> => {
  const groups = new Map<string, Record[]>();

  for (const record of records) {
    const group = groups.get(record.callId) ?? [];

    group.push(record);
    groups.set(record.callId, group);
  }

  return groups;
};

const pairRemainder = (
  pairs: OccurrencePair[],
  calls: CallOccurrence[],
  results: ResultOccurrence[],
): Pairing => {
  if (calls.length === 0) {
    return { pairs, unanswered: [], unmatched: results, ambiguous: 0 };
  }

  if (results.length === 0) {
    return { pairs, unanswered: calls, unmatched: [], ambiguous: 0 };
  }

  const [call] = calls;
  const [result] = results;
  const unambiguous = calls.length === 1 && results.length === 1;

  if (unambiguous && call !== undefined && result !== undefined) {
    return { pairs: [...pairs, { call, result }], unanswered: [], unmatched: [], ambiguous: 0 };
  }

  return { pairs, unanswered: [], unmatched: [], ambiguous: calls.length + results.length };
};

const addVote = (votes: Map<number, Set<number>>, key: number, value: number) => {
  const values = votes.get(key) ?? new Set<number>();

  values.add(value);
  votes.set(key, values);
};

const filesOf = (
  calls: readonly CallOccurrence[],
  results: readonly ResultOccurrence[],
): Set<string> => {
  const files = new Set<string>();

  for (const call of calls) {
    for (const place of call.places) {
      files.add(place.file);
    }
  }

  for (const result of results) {
    for (const place of result.places) {
      files.add(place.file);
    }
  }

  return files;
};

const scanEvents = (
  file: string,
  calls: readonly CallOccurrence[],
  results: readonly ResultOccurrence[],
): ScanEvent[] => {
  const events: ScanEvent[] = [];

  for (const call of calls) {
    for (const place of call.places) {
      if (place.file === file) {
        events.push({ index: place.index, kind: 'call', call });
      }
    }
  }

  for (const result of results) {
    for (const place of result.places) {
      if (place.file === file) {
        events.push({ index: place.index, kind: 'result', result });
      }
    }
  }

  return events.toSorted((left, right) => left.index - right.index);
};

const scanFile = (
  file: string,
  calls: readonly CallOccurrence[],
  results: readonly ResultOccurrence[],
  callVotes: Map<number, Set<number>>,
  resultVotes: Map<number, Set<number>>,
) => {
  const open: CallOccurrence[] = [];

  for (const event of scanEvents(file, calls, results)) {
    if (event.kind === 'call') {
      open.push(event.call);

      continue;
    }

    if (open.length !== 1) {
      continue;
    }

    const call = open.pop();

    if (call !== undefined) {
      addVote(callVotes, call.id, event.result.id);
      addVote(resultVotes, event.result.id, call.id);
    }
  }
};

const pairOccurrences = (
  calls: readonly CallOccurrence[],
  results: readonly ResultOccurrence[],
): Pairing => {
  const callVotes = new Map<number, Set<number>>();
  const resultVotes = new Map<number, Set<number>>();

  for (const file of filesOf(calls, results)) {
    scanFile(file, calls, results, callVotes, resultVotes);
  }

  const pairs: OccurrencePair[] = [];
  const pairedCalls = new Set<number>();
  const pairedResults = new Set<number>();

  for (const call of calls) {
    const votedResults = callVotes.get(call.id);

    if (votedResults?.size !== 1) {
      continue;
    }

    const [resultId] = [...votedResults];
    const result = results.find((candidate) => candidate.id === resultId);

    if (result === undefined || resultVotes.get(result.id)?.size !== 1) {
      continue;
    }

    pairs.push({ call, result });
    pairedCalls.add(call.id);
    pairedResults.add(result.id);
  }

  const remainingCalls = calls.filter((call) => !pairedCalls.has(call.id));
  const remainingResults = results.filter((result) => !pairedResults.has(result.id));

  return pairRemainder(pairs, remainingCalls, remainingResults);
};

const pairCalls = (
  state: LogState,
  calls: readonly CallOccurrence[],
  results: readonly ResultOccurrence[],
) => {
  const callGroups = groupByCallId(calls);
  const resultGroups = groupByCallId(results);
  const callIds = new Set([...callGroups.keys(), ...resultGroups.keys()]);

  for (const callId of callIds) {
    const pairing = pairOccurrences(callGroups.get(callId) ?? [], resultGroups.get(callId) ?? []);

    for (const pair of pairing.pairs) {
      readCall(state, {
        parameters: pair.call.parameters,
        result: pair.result.result,
        session: pair.result.session,
        time: pair.result.time,
        callTime: pair.call.time,
      });
    }

    state.skipped.unansweredCalls += pairing.unanswered.length;

    state.skipped.unmatchedResults += pairing.unmatched.filter((result) =>
      isQuestionResult(result.toolName, result.result.details),
    ).length;

    state.skipped.ambiguousEntries += pairing.ambiguous;
  }
};

const collectEntry = (state: LogState, file: string, index: number, entry: Entry) => {
  const time = Date.parse(text(entry.timestamp) ?? '');

  if (Number.isNaN(time)) {
    state.skipped.malformedLines += 1;

    return;
  }

  const key = copyKey(entry);
  const first = state.firstFiles.get(key);

  if (first === undefined) {
    state.firstFiles.set(key, file);
  } else {
    state.skipped.copiedEntries += 1;

    if (first !== file) {
      state.sharedFiles.push([first, file]);
    }
  }

  if (!isQuestionEntry(entry)) {
    return;
  }

  const known = state.entries.get(key);

  if (known === undefined) {
    state.entries.set(key, { entry, time, places: [{ file, index }] });

    return;
  }

  known.places.push({ file, index });
};

export const questionLogReader = (): QuestionLogReader => {
  const logs: ParsedLog[] = [];

  const state: LogState = {
    questions: [],
    skipped: zeroSkipped(),
    entries: new Map(),
    firstFiles: new Map(),
    sharedFiles: [],
  };

  const add = (file: SessionLog) => {
    const { entries, malformedLines } = parseEntries(file.text);

    logs.push({ path: file.path, malformedLines, parent: sessionParent(entries) });
    state.skipped.malformedLines += malformedLines;

    for (const [index, entry] of entries.entries()) {
      collectEntry(state, file.path, index, entry);
    }
  };

  const finish = (): QuestionLog => {
    const keys = sessionKeys(logs, state.sharedFiles);
    const { calls, results } = readOccurrences(state, keys);

    pairCalls(state, calls, results);

    return {
      questions: state.questions.toSorted((left, right) => left.time - right.time),
      skipped: state.skipped,
    };
  };

  return { add, finish };
};

export const readLoggedQuestions = (files: readonly SessionLog[]): QuestionLog => {
  const reader = questionLogReader();

  for (const file of files) {
    reader.add(file);
  }

  return reader.finish();
};
