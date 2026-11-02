import type { RunnerResult } from './runner/types.js';
import type { Behavior, Freshness, TestScope } from './types.js';

// Decides observation cycle transitions from facts the caller read.
// tests/structure.test.ts keeps this module pure.

type HintKind = 'red' | 'stale' | 'unknown' | 'thrown';

export interface HintDecision {
  kind: HintKind;
  errorType: string | undefined;
}

export interface LatestRun {
  behavior: Behavior;
  scope: TestScope;
  kind: RunnerResult['kind'];
  fingerprint: string | null;
  freshness: Freshness;
}

export interface CycleState {
  active: string | null;
  observedRed: boolean;
  latest: LatestRun | null;
  shownHints: ReadonlySet<HintKind>;
  staleHintInput: string | null;
}

export interface CycleTransition {
  state: CycleState;
  hint: HintDecision | undefined;
}

export type CheckpointInput =
  | { kind: 'skipped' }
  | { kind: 'unavailable' }
  | { kind: 'value'; hash: string };

export interface RunCompletedFacts {
  behavior: Behavior;
  scope: TestScope;
  kind: RunnerResult['kind'];
  fingerprint: string | null;
  freshness: Freshness;
  selectionFailed: boolean;
  thrownErrorType: string | null;
}

export const testNames = (behavior: Behavior): string[] =>
  Array.isArray(behavior.testFullName) ? behavior.testFullName : [behavior.testFullName];

export const identity = (behavior: Behavior): string =>
  JSON.stringify([behavior.files, testNames(behavior)]);

export const compareInputs = (before: string | null, after: string | null): Freshness => {
  if (before === null || after === null) {
    return 'unknown';
  }

  return before === after ? 'fresh' : 'stale';
};

export const startRun = (state: CycleState, behavior: Behavior): CycleState => {
  const key = identity(behavior);

  const continuesLatest =
    state.active === null && state.latest !== null && identity(state.latest.behavior) === key;

  if (state.active === key || continuesLatest) {
    return { ...state, active: key };
  }

  return { ...state, active: key, observedRed: false, shownHints: new Set<HintKind>() };
};

const hintDecision = (condition: HintKind, errorType: string | null): HintDecision =>
  condition === 'thrown'
    ? { kind: condition, errorType: errorType ?? undefined }
    : { kind: condition, errorType: undefined };

const applyHint = (
  state: CycleState,
  condition: HintKind,
  input: string | null,
  errorType: string | null = null,
): CycleTransition => {
  if (state.shownHints.has(condition)) {
    return { state, hint: undefined };
  }

  const shownHints = new Set(state.shownHints).add(condition);

  if (condition === 'stale' || condition === 'unknown') {
    return {
      state: { ...state, shownHints, staleHintInput: input },
      hint: hintDecision(condition, errorType),
    };
  }

  return { state: { ...state, shownHints }, hint: hintDecision(condition, errorType) };
};

export const completeRun = (state: CycleState, facts: RunCompletedFacts): CycleTransition => {
  const previous = state.latest;

  let next: CycleState = {
    ...state,
    latest: {
      behavior: facts.behavior,
      scope: facts.scope,
      kind: facts.kind,
      fingerprint: facts.fingerprint,
      freshness: facts.freshness,
    },
  };

  const observedSelectionFailure =
    facts.freshness === 'fresh' && facts.scope === 'focused' && facts.selectionFailed;

  let thrownType: string | null = null;

  if (observedSelectionFailure) {
    if (!next.observedRed) {
      next = { ...next, shownHints: new Set<HintKind>() };
    }

    next = { ...next, observedRed: true };
    thrownType = facts.thrownErrorType;
  }

  if (previous?.freshness !== facts.freshness && facts.freshness === 'fresh') {
    next = { ...next, shownHints: new Set<HintKind>() };
  }

  if (thrownType !== null) {
    return applyHint(next, 'thrown', facts.fingerprint, thrownType);
  }

  if (facts.freshness !== 'fresh') {
    return applyHint(next, facts.freshness, facts.fingerprint);
  }

  if (facts.scope === 'full' && facts.kind === 'pass') {
    next = { ...next, active: null, observedRed: false, shownHints: new Set<HintKind>() };
  }

  return { state: next, hint: undefined };
};

export const checkpointNeedsInputHash = (state: CycleState): boolean => {
  const latest = state.latest;

  if (latest === null) {
    return false;
  }

  if (latest.fingerprint === null) {
    return false;
  }

  const canSuggestRed = !state.observedRed && !state.shownHints.has('red');

  return latest.freshness !== 'stale' || canSuggestRed;
};

const isExpectedImplementationEdit = (state: CycleState, latest: LatestRun): boolean =>
  state.observedRed && latest.scope === 'focused' && latest.freshness === 'stale';

const suggestsMissingRed = (
  state: CycleState,
  freshness: 'stale' | 'unknown',
  current: string | null,
): boolean => {
  if (state.observedRed || !state.shownHints.has(freshness)) {
    return false;
  }

  return current !== null && current !== state.staleHintInput;
};

const editHint = (state: CycleState, current: string | null): CycleTransition => {
  const latest = state.latest;

  if (latest !== null && latest.freshness !== 'fresh') {
    const freshness = latest.freshness;

    // Changing production is expected while implementing an observed focused failure.
    if (isExpectedImplementationEdit(state, latest)) {
      return { state, hint: undefined };
    }

    // Keep stale-first after verification. Only a later input change can suggest missing RED.
    if (suggestsMissingRed(state, freshness, current)) {
      return applyHint(state, 'red', current);
    }

    return applyHint(state, freshness, current);
  }

  if (latest?.scope === 'full' && latest.kind === 'pass') {
    return { state, hint: undefined };
  }

  if (state.observedRed) {
    return { state, hint: undefined };
  }

  return applyHint(state, 'red', null);
};

export const checkpoint = (
  state: CycleState,
  input: CheckpointInput,
  productionEdit: boolean,
): CycleTransition => {
  const latest = state.latest;
  let next = state;
  let current: string | null = null;

  if (latest !== null && latest.fingerprint !== null) {
    if (input.kind === 'unavailable') {
      // A read failure must not erase stale evidence; only unknown freshness may recover.
      if (latest.freshness !== 'stale') {
        next = { ...next, latest: { ...latest, freshness: 'unknown' } };
      }
    } else if (input.kind === 'value') {
      current = input.hash;

      if (current !== latest.fingerprint) {
        next = { ...next, latest: { ...latest, freshness: 'stale' } };
      } else if (latest.freshness === 'unknown') {
        next = { ...next, latest: { ...latest, freshness: 'fresh' } };
      }
    }
  }

  if (!productionEdit) {
    return { state: next, hint: undefined };
  }

  return editHint(next, current);
};
