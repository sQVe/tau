import { isStopped } from '../../verification/freshness.js';
import type {
  ItemRecord,
  RecordRead,
  RunRecord,
  Step,
  StepOutcome,
} from '../../verification/records.js';
import type { RecordInput } from './recordParameters.js';

export interface ArtifactFact {
  step: number;
  path: string;
  location: 'inside' | 'outside' | 'missing' | 'unreadable';
}

export interface ItemFacts {
  run: string;
  runRead: RecordRead<RunRecord>;
  item: string;
  steps: RecordInput['steps'];
  endState: StepOutcome | undefined;
  itemFileExists: boolean;
  artifacts: readonly ArtifactFact[];
}

export type ItemDecision =
  | { kind: 'refuse'; reason: string }
  | { kind: 'write'; record: Omit<ItemRecord, 'version'> };

const registeredNames = (items: RunRecord['items']): string =>
  items.length === 0 ? 'none' : items.map(({ item }) => item).join(', ');

const firstArtifact = (
  artifacts: readonly ArtifactFact[],
  location: ArtifactFact['location'],
): ArtifactFact | undefined => artifacts.find((artifact) => artifact.location === location);

const numberedStep = (step: RecordInput['steps'][number], index: number): Step => ({
  ...step,
  number: index + 1,
});

export const alreadyRecordedReason = (run: string, item: string): string =>
  `Item ${item} already has a result in run ${run}. Each item is recorded once.`;

export const decideItemWrite = (facts: ItemFacts): ItemDecision => {
  const { run, runRead, item, steps, endState, itemFileExists, artifacts } = facts;

  if (runRead.status === 'missing') {
    return {
      kind: 'refuse',
      reason: `Run ${run} has no run.json; the manager launches a run first.`,
    };
  }

  if (runRead.status === 'malformed') {
    return {
      kind: 'refuse',
      reason: `Run ${run} has a malformed run.json: ${runRead.problem}`,
    };
  }

  const record = runRead.record;

  if (record.run !== run) {
    return {
      kind: 'refuse',
      reason: `Run ${run} has a malformed run.json: it names run ${record.run}.`,
    };
  }

  if (isStopped(record)) {
    return {
      kind: 'refuse',
      reason: `Run ${run} is stopped; record results before the manager stops it.`,
    };
  }

  const registered = record.items.find((entry) => entry.item === item);

  if (registered === undefined) {
    return {
      kind: 'refuse',
      reason: `Item ${item} is not registered in run ${run}. Registered: ${registeredNames(record.items)}.`,
    };
  }

  if (registered.steps !== steps.length) {
    return {
      kind: 'refuse',
      reason: `Item ${item} has ${registered.steps} registered steps in run ${run}, but ${steps.length} results were given.`,
    };
  }

  if (endState === undefined) {
    return { kind: 'refuse', reason: `Item ${item} needs an endState result.` };
  }

  if (itemFileExists) {
    return {
      kind: 'refuse',
      reason: alreadyRecordedReason(run, item),
    };
  }

  const outside = firstArtifact(artifacts, 'outside');

  if (outside !== undefined) {
    return {
      kind: 'refuse',
      reason: `Step ${outside.step} artifact ${outside.path} is outside the run directory.`,
    };
  }

  const missing = firstArtifact(artifacts, 'missing');

  if (missing !== undefined) {
    return {
      kind: 'refuse',
      reason: `Step ${missing.step} artifact ${missing.path} does not exist in the run directory.`,
    };
  }

  const unreadable = firstArtifact(artifacts, 'unreadable');

  if (unreadable !== undefined) {
    return {
      kind: 'refuse',
      reason: `Step ${unreadable.step} artifact ${unreadable.path} cannot be read in the run directory.`,
    };
  }

  return {
    kind: 'write',
    record: {
      run,
      item,
      drive: 'hand',
      steps: steps.map(numberedStep),
      endState,
    },
  };
};
