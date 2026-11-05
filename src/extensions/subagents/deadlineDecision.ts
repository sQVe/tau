export type DeadlineAssignment =
  | { kind: 'none' }
  | { kind: 'unread'; message: string }
  | { kind: 'missing'; path: string }
  | { kind: 'malformed'; path: string; message: string }
  | {
      kind: 'saved';
      path: string;
      assignmentId: string;
      parentSession: string;
      deadline: number;
      reported: boolean;
    };

export interface DeadlineChildFact {
  address: string;
  parent: string | undefined;
  state: string;
  labels: Record<string, string> | undefined;
  assignment: DeadlineAssignment;
}

export interface DeadlineFacts {
  managerTerminal: string;
  now: number;
  children: readonly DeadlineChildFact[];
}

export interface DeadlineTimer {
  address: string;
  assignmentPath: string;
  assignmentId: string;
  parentSession: string;
  warnAt: number;
  killAt: number;
}

export interface DeadlineKill {
  address: string;
  assignmentPath: string;
  assignmentId?: string;
  parentSession?: string;
}

interface DeadlineError {
  key: string;
  message: string;
}

export interface DeadlinePlan {
  armed: DeadlineTimer[];
  kills: DeadlineKill[];
  errors: DeadlineError[];
}

export interface ArmedTimerFact {
  killAt: number;
}

export const deadlineWarningReserve = 90_000;

export const deadlineEndLabel = { key: 'tau.ended', value: 'deadline' } as const;

export const reuseArmedTimer = (
  current: ArmedTimerFact | undefined,
  next: ArmedTimerFact,
): boolean => current !== undefined && current.killAt === next.killAt;

const labelMessage = (assignmentId: string, label: string | undefined, deadline: number): string =>
  label === undefined
    ? `Worker ${assignmentId} has no tau.deadline label; using the assignment deadline ${deadline}.`
    : `Worker ${assignmentId} has tau.deadline label "${label}"; using the assignment deadline ${deadline}.`;

const labelMismatch = (label: string | undefined, deadline: number): boolean =>
  Number(label) !== deadline;

const decideSaved = (
  facts: DeadlineFacts,
  child: DeadlineChildFact,
  assignment: Extract<DeadlineAssignment, { kind: 'saved' }>,
  plan: DeadlinePlan,
): void => {
  if (child.state !== 'live' || assignment.reported) {
    return;
  }

  const label = child.labels?.['tau.deadline'];

  if (labelMismatch(label, assignment.deadline)) {
    plan.errors.push({
      key: `label:${assignment.assignmentId}`,
      message: labelMessage(assignment.assignmentId, label, assignment.deadline),
    });
  }

  if (assignment.deadline <= facts.now) {
    plan.kills.push({
      address: child.address,
      assignmentPath: assignment.path,
      assignmentId: assignment.assignmentId,
      parentSession: assignment.parentSession,
    });

    return;
  }

  plan.armed.push({
    address: child.address,
    assignmentPath: assignment.path,
    assignmentId: assignment.assignmentId,
    parentSession: assignment.parentSession,
    warnAt: Math.max(facts.now, assignment.deadline - deadlineWarningReserve),
    killAt: assignment.deadline,
  });
};

const decideChild = (facts: DeadlineFacts, child: DeadlineChildFact, plan: DeadlinePlan): void => {
  if (child.parent !== facts.managerTerminal) {
    return;
  }

  const { assignment } = child;

  if (assignment.kind === 'unread') {
    plan.errors.push({ key: `unread:${child.address}`, message: assignment.message });

    return;
  }

  const assignmentLabel = child.labels?.['tau.assignment'];

  if (assignmentLabel === undefined || assignmentLabel === '') {
    return;
  }

  if (assignment.kind === 'none') {
    return;
  }

  if (assignment.kind === 'missing') {
    plan.errors.push({
      key: `assignment:${assignment.path}`,
      message: `Missing assignment file: ${assignment.path}.`,
    });

    plan.kills.push({ address: child.address, assignmentPath: assignment.path });

    return;
  }

  if (assignment.kind === 'malformed') {
    plan.errors.push({ key: `assignment:${assignment.path}`, message: assignment.message });
    plan.kills.push({ address: child.address, assignmentPath: assignment.path });

    return;
  }

  decideSaved(facts, child, assignment, plan);
};

export const decideDeadline = (facts: DeadlineFacts): DeadlinePlan => {
  const plan: DeadlinePlan = { armed: [], kills: [], errors: [] };

  for (const child of facts.children) {
    decideChild(facts, child, plan);
  }

  return plan;
};
