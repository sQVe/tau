import type { Assignment } from './assignment.js';
import { ownerRefusal } from './ownerRefusal.js';

export type AssignmentFact =
  | { kind: 'missing' }
  | { kind: 'malformed'; message: string }
  | { kind: 'saved'; assignment: Assignment };

export interface AssignmentFacts {
  assignmentId: string;
  questionId: string;
  path: string;
  parentSession: string;
  read: AssignmentFact;
}

export type AssignmentDecision =
  | { kind: 'refused'; reason: string }
  | { kind: 'answerable'; assignment: Assignment };

export interface TargetTerminal {
  address: string;
  state: string;
  parent?: string | null | undefined;
  labels?: Record<string, string> | undefined;
}

export interface TargetFacts {
  managerTerminal: string;
  path: string;
  terminals: readonly TargetTerminal[];
}

export type TargetDecision =
  | { kind: 'refused'; reason: string }
  | { kind: 'target'; terminal: string };

export interface TargetChangeFacts {
  managerTerminal: string;
  path: string;
  terminal: TargetTerminal;
}

export interface LeaseFacts {
  terminal: string;
  leaseSessionId: string;
  workerSessionId: string;
}

const nothingSaved = 'No answer was saved.';

const refused = (reason: string): { kind: 'refused'; reason: string } => ({
  kind: 'refused',
  reason: `${reason} ${nothingSaved}`,
});

const openQuestionProblem = (assignment: Assignment, questionId: string): string | undefined => {
  const open = assignment.questions.at(-1);

  if (open === undefined) {
    return `Assignment ${assignment.assignmentId} has no saved question.`;
  }

  if (open.questionId !== questionId) {
    return `Question ${questionId} is not the open question of assignment ${assignment.assignmentId}; the open question is ${open.questionId}.`;
  }

  return undefined;
};

export const decideAssignment = (facts: AssignmentFacts): AssignmentDecision => {
  const { read } = facts;

  if (read.kind === 'missing') {
    return refused(`Missing assignment ${facts.path}.`);
  }

  if (read.kind === 'malformed') {
    return refused(read.message);
  }

  const { assignment } = read;

  if (assignment.assignmentId !== facts.assignmentId) {
    return refused(
      `${facts.path} names assignment ${assignment.assignmentId}, not ${facts.assignmentId}.`,
    );
  }

  const ownerProblem = ownerRefusal(assignment, facts.parentSession);

  if (ownerProblem !== undefined) {
    return refused(ownerProblem);
  }

  if (assignment.report !== null) {
    return refused(`Assignment ${assignment.assignmentId} already has a report.`);
  }

  const questionProblem = openQuestionProblem(assignment, facts.questionId);

  return questionProblem === undefined
    ? { kind: 'answerable', assignment }
    : refused(questionProblem);
};

const targetProblem = (
  terminal: TargetTerminal,
  managerTerminal: string,
  path: string,
): string | undefined => {
  if (terminal.state !== 'live') {
    return 'it is not live';
  }

  if (terminal.parent !== managerTerminal) {
    return `its parent is ${terminal.parent ?? 'none'}, not ${managerTerminal}`;
  }

  const label = terminal.labels?.['tau.assignment'];

  if (label !== path) {
    return `its tau.assignment label is ${label ?? 'missing'}, not ${path}`;
  }

  return undefined;
};

export const decideTarget = (facts: TargetFacts): TargetDecision => {
  const matches = facts.terminals.filter(
    (terminal) => targetProblem(terminal, facts.managerTerminal, facts.path) === undefined,
  );

  const [only] = matches;

  if (only === undefined) {
    return refused(
      `No live worker terminal of ${facts.managerTerminal} carries assignment ${facts.path}.`,
    );
  }

  if (matches.length > 1) {
    const addresses = matches.map((terminal) => terminal.address).join(', ');

    return refused(`Several live worker terminals carry assignment ${facts.path}: ${addresses}.`);
  }

  return { kind: 'target', terminal: only.address };
};

export const targetChangeRefusal = (facts: TargetChangeFacts): string | undefined => {
  const problem = targetProblem(facts.terminal, facts.managerTerminal, facts.path);

  return problem === undefined
    ? undefined
    : `Worker terminal ${facts.terminal.address} changed before the answer was saved: ${problem}. ${nothingSaved}`;
};

export const leaseRefusal = (facts: LeaseFacts): string | undefined =>
  facts.leaseSessionId === facts.workerSessionId
    ? undefined
    : `${facts.terminal} has inbox session ${facts.leaseSessionId}, not worker session ${facts.workerSessionId}. ${nothingSaved}`;
