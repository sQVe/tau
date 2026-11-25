import {
  assert,
  boolean,
  cloneMethod,
  commands,
  constant,
  constantFrom,
  modelRun,
  oneof,
  property,
  tuple,
} from 'fast-check';
import type { Command } from 'fast-check';
import { expect, it } from 'vitest';

import { resolvePropertySeed } from '../../../tests/propertySeedHarness.ts';
import { isRecord } from '../../schema.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import {
  createManager,
  manager,
  managerSession,
  otherSession,
  savedAssignment,
  savedQuestion,
  savedReport,
} from './fixtures/deliveryManager.js';
import { createWorkerDelivery } from './workerDelivery.js';
import type { WorkerChildRead, WorkerDelivery } from './workerDelivery.js';

type Manager = ReturnType<typeof createManager>;

interface AssignmentState {
  assignment: Assignment;
  address: string;
  path: string;
  state: string;
  labels: Record<string, string>;
}

interface World {
  assignments: AssignmentState[];
  delivery: WorkerDelivery;
  phases: number[];
  polledSinceReport: boolean[];
  nextQuestion: number;
}

type NoticeKind = 'report' | 'question' | 'ended' | 'deadline';

interface Notice {
  kind: NoticeKind;
  assignmentId: string;
  questionId: string | undefined;
  session: string;
}

const executedSteps = new Set<string>();

const expectedSteps = [
  'poll',
  'ask question',
  'save report',
  'normal finish',
  'deadline read terminal',
  'deadline check report',
  'deadline mark pending',
  'deadline kill',
  'deadline clear pending',
  'deadline showEnded',
  'deadline write label',
  'switch session',
  'restart',
];

const recordStep = (step: string): void => {
  executedSteps.add(step);
};

const assignmentState = (
  assignmentId: string,
  parentSession: string,
  address: string,
  path: string,
): AssignmentState => ({
  assignment: {
    ...savedAssignment('/agent', null),
    assignmentId,
    parentSession,
  },
  address,
  path,
  state: 'live',
  labels: { 'tau.assignment': path },
});

const createWorld = (managerState: Manager): World => ({
  assignments: [
    assignmentState(
      '00000000-0000-4000-8000-000000000001',
      managerSession,
      't-child-1',
      '/agent/assignment-1.json',
    ),
    assignmentState(
      '00000000-0000-4000-8000-000000000002',
      otherSession,
      't-child-2',
      '/agent/assignment-2.json',
    ),
  ],
  delivery: createWorkerDelivery(managerState.pi, () => ''),
  phases: [0, 0],
  polledSinceReport: [false, false],
  nextQuestion: 1,
});

const childRead = (state: AssignmentState): WorkerChildRead => ({
  terminal: {
    address: state.address,
    state: state.state,
    parent: manager,
    labels: state.labels,
  },
  assignment: { kind: 'saved', path: state.path, assignment: state.assignment },
});

const noticeKind = (customType: unknown): NoticeKind | undefined => {
  switch (customType) {
    case 'tau-worker-report':
      return 'report';
    case 'tau-worker-question':
      return 'question';
    case 'tau-worker-ended':
      return 'ended';
    case 'tau-worker-deadline':
      return 'deadline';
    default:
      return undefined;
  }
};

const readNotices = (managerState: Manager): Notice[] => {
  const notices: Notice[] = [];

  for (const session of [managerSession, otherSession]) {
    for (const entry of managerState.entriesOf(session)) {
      if (entry.type !== 'custom_message') {
        continue;
      }

      const kind = noticeKind(entry.customType);

      if (kind === undefined || !isRecord(entry.details)) {
        continue;
      }

      const assignmentId = entry.details['assignmentId'];

      if (typeof assignmentId !== 'string') {
        continue;
      }

      const questionId = entry.details['questionId'];

      const noticeQuestionId = typeof questionId === 'string' ? questionId : undefined;

      notices.push({
        kind,
        assignmentId,
        questionId: noticeQuestionId,
        session,
      });
    }
  }

  return notices;
};

const assertInvariants = (world: World, managerState: Manager): void => {
  const notices = readNotices(managerState);
  const noticeCounts = new Map<string, number>();
  const finalCounts = new Map<string, number>();
  const reportCounts = new Map<string, number>();
  const reportedAssignments = new Set<string>();

  for (const notice of notices) {
    const state = world.assignments.find(
      (candidate) => candidate.assignment.assignmentId === notice.assignmentId,
    );

    expect(state, `notice for unknown assignment ${notice.assignmentId}`).toBeDefined();

    if (state === undefined) {
      continue;
    }

    expect(notice.session, `notice for ${notice.assignmentId} in the wrong session`).toBe(
      state.assignment.parentSession,
    );

    const key = `${notice.kind}:${notice.assignmentId}:${notice.questionId ?? ''}`;

    noticeCounts.set(key, (noticeCounts.get(key) ?? 0) + 1);

    if (notice.kind === 'report') {
      reportCounts.set(notice.assignmentId, (reportCounts.get(notice.assignmentId) ?? 0) + 1);
      reportedAssignments.add(notice.assignmentId);
    }

    if (notice.kind === 'ended' || notice.kind === 'deadline') {
      expect(
        reportedAssignments.has(notice.assignmentId),
        `${notice.kind} notice for ${notice.assignmentId} after its report`,
      ).toBe(false);

      finalCounts.set(notice.assignmentId, (finalCounts.get(notice.assignmentId) ?? 0) + 1);
    }
  }

  for (const [key, count] of noticeCounts) {
    expect(count, `notice ${key} repeated`).toBe(1);
  }

  for (const [assignmentId, count] of finalCounts) {
    expect(count, `final notices for ${assignmentId}`).toBeLessThanOrEqual(1);
  }

  for (const [index, state] of world.assignments.entries()) {
    if (world.polledSinceReport[index] === true) {
      expect(
        reportCounts.get(state.assignment.assignmentId) ?? 0,
        `report for ${state.assignment.assignmentId} after a poll in its launching session`,
      ).toBe(1);
    }
  }
};

abstract class WorldCommand implements Command<World, Manager> {
  abstract check(model: Readonly<World>): boolean;

  abstract apply(model: World, real: Manager): void;

  abstract toString(): string;

  run(model: World, real: Manager): void {
    this.apply(model, real);
    assertInvariants(model, real);
  }
}

class PollCommand extends WorldCommand {
  check(): boolean {
    return true;
  }

  apply(model: World, real: Manager): void {
    recordStep('poll');

    const sessionFile = real.context.sessionManager.getSessionFile();

    model.delivery.deliver(
      real.context,
      model.assignments.map((state) => childRead(state)),
    );

    for (const [index, state] of model.assignments.entries()) {
      if (state.assignment.parentSession === sessionFile && state.assignment.report !== null) {
        model.polledSinceReport[index] = true;
      }
    }
  }

  toString(): string {
    return 'poll';
  }
}

class AskQuestionCommand extends WorldCommand {
  private readonly index: number;

  constructor(index: number) {
    super();
    this.index = index;
  }

  check(): boolean {
    return true;
  }

  apply(model: World): void {
    recordStep('ask question');

    const state = model.assignments[this.index];

    if (state === undefined) {
      return;
    }

    const question: SavedQuestion = {
      ...savedQuestion(),
      questionId: `00000000-0000-4000-8000-${String(model.nextQuestion).padStart(12, '0')}`,
    };

    model.nextQuestion += 1;
    state.assignment.questions = [...state.assignment.questions, question];
  }

  toString(): string {
    return `ask question assignment ${this.index + 1}`;
  }
}

class SaveReportCommand extends WorldCommand {
  private readonly index: number;

  constructor(index: number) {
    super();
    this.index = index;
  }

  check(): boolean {
    return true;
  }

  apply(model: World): void {
    recordStep('save report');

    const state = model.assignments[this.index];

    if (state === undefined) {
      return;
    }

    state.assignment.report = savedReport();
    model.polledSinceReport[this.index] = false;
  }

  toString(): string {
    return `save report assignment ${this.index + 1}`;
  }
}

class NormalFinishCommand extends WorldCommand {
  private readonly index: number;

  constructor(index: number) {
    super();
    this.index = index;
  }

  check(): boolean {
    return true;
  }

  apply(model: World): void {
    recordStep('normal finish');

    const state = model.assignments[this.index];

    if (state !== undefined) {
      state.state = 'finished';
    }
  }

  toString(): string {
    return `normal finish assignment ${this.index + 1}`;
  }
}

class DeadlineStepCommand extends WorldCommand {
  private step = 'read terminal';
  private readonly index: number;
  private readonly killSuccess: boolean;
  private readonly labelSuccess: boolean;

  constructor(index: number, killSuccess: boolean, labelSuccess: boolean) {
    super();
    this.index = index;
    this.killSuccess = killSuccess;
    this.labelSuccess = labelSuccess;
  }

  check(model: Readonly<World>): boolean {
    const phase = model.phases[this.index];

    if (phase === undefined || phase >= 6) {
      return false;
    }

    this.step = [
      'read terminal',
      'check report',
      'mark pending',
      'kill',
      'showEnded',
      'write label',
    ][phase] as string;

    return true;
  }

  apply(model: World, real: Manager): void {
    const state = model.assignments[this.index];

    if (state === undefined) {
      return;
    }

    const phase = model.phases[this.index];

    if (phase !== 5 || this.labelSuccess) {
      recordStep(`deadline ${this.step}`);
    }

    if (phase === 0) {
      if (state.state === 'live') {
        model.phases[this.index] = 1;
      }

      return;
    }

    if (phase === 1) {
      model.phases[this.index] = state.assignment.report === null ? 2 : 0;

      return;
    }

    if (phase === 2) {
      model.delivery.markDeadlinePending(state.assignment.assignmentId);
      model.phases[this.index] = 3;

      return;
    }

    if (phase === 3) {
      if (this.killSuccess) {
        state.state = 'finished';
        model.phases[this.index] = 4;

        return;
      }

      recordStep('deadline clear pending');
      model.delivery.clearDeadlinePending(state.assignment.assignmentId);
      model.phases[this.index] = 0;

      return;
    }

    if (phase === 4) {
      model.delivery.showEnded(real.context, {
        assignmentId: state.assignment.assignmentId,
        address: state.address,
        parentSession: state.assignment.parentSession,
      });

      model.phases[this.index] = 5;

      return;
    }

    if (this.labelSuccess) {
      state.labels['tau.ended'] = 'deadline';
    }

    model.phases[this.index] = 6;
  }

  [cloneMethod](): DeadlineStepCommand {
    return new DeadlineStepCommand(this.index, this.killSuccess, this.labelSuccess);
  }

  toString(): string {
    return `deadline ${this.step} assignment ${this.index + 1}`;
  }
}

class SwitchSessionCommand extends WorldCommand {
  check(): boolean {
    return true;
  }

  apply(_model: World, real: Manager): void {
    recordStep('switch session');

    const current = real.context.sessionManager.getSessionFile();

    const nextSession = current === managerSession ? otherSession : managerSession;
    real.switchSession(nextSession);
  }

  toString(): string {
    return 'switch session';
  }
}

class RestartCommand extends WorldCommand {
  check(): boolean {
    return true;
  }

  apply(model: World, real: Manager): void {
    recordStep('restart');

    model.delivery = createWorkerDelivery(real.pi, () => '');
    model.phases = [0, 0];
  }

  toString(): string {
    return 'restart';
  }
}

const assignmentIndex = constantFrom(0, 1);

const deadlineStepCommand = tuple(assignmentIndex, boolean(), boolean()).map(
  ([index, killSuccess, labelSuccess]) => {
    return new DeadlineStepCommand(index, killSuccess, labelSuccess);
  },
);

const commandArbitrary = oneof(
  { arbitrary: constant(new PollCommand()), weight: 1 },
  { arbitrary: assignmentIndex.map((index) => new AskQuestionCommand(index)), weight: 1 },
  { arbitrary: assignmentIndex.map((index) => new SaveReportCommand(index)), weight: 1 },
  { arbitrary: assignmentIndex.map((index) => new NormalFinishCommand(index)), weight: 1 },
  {
    arbitrary: deadlineStepCommand,
    weight: 5,
  },
  { arbitrary: constant(new SwitchSessionCommand()), weight: 1 },
  { arbitrary: constant(new RestartCommand()), weight: 1 },
);

it('keeps one report notice and at most one final notice per worker', () => {
  const seed = resolvePropertySeed();

  executedSteps.clear();

  assert(
    property(
      commands([commandArbitrary], { maxCommands: 100, size: 'max' }),
      (generatedCommands) => {
        modelRun(() => {
          const managerState = createManager();

          return { model: createWorld(managerState), real: managerState };
        }, generatedCommands);
      },
    ),
    { seed, numRuns: 100 },
  );

  const missingSteps = expectedSteps.filter((step) => !executedSteps.has(step));

  expect(missingSteps, `command steps never executed: ${missingSteps.join(', ')}`).toEqual([]);
});
