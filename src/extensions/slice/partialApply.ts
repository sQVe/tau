import { errorMessage } from '../../errors.js';

export interface PartialApplyCreate {
  identifier: string;
  url: string;
}

export interface PartialApplyStep<Summary> {
  summary: Summary;
  run: () => Promise<void>;
}

export interface PartialApplyFailure<Summary> {
  message: string;
  directory: string;
  applied: readonly Summary[];
  notApplied: readonly Summary[];
  created: PartialApplyCreate | null;
}

export interface PartialApplyFailureDetails<Summary> {
  status: 'failed';
  error: string;
  directory: string;
  applied: readonly Summary[];
  notApplied: readonly Summary[];
  created: PartialApplyCreate | null;
}

export interface ApplyRunner<Summary> {
  describe: (summary: Summary) => string;
  directory: () => string;
  recordIdentifier: (created: PartialApplyCreate) => Summary;
  signal: AbortSignal | undefined;
}

export class CreatedButNotRecordedError extends Error {
  readonly created: PartialApplyCreate;

  constructor(created: PartialApplyCreate, options: ErrorOptions) {
    super(`Linear created ${created.identifier}, but saving its identifier failed.`, options);
    this.name = 'CreatedButNotRecordedError';
    this.created = { identifier: created.identifier, url: created.url };
  }
}

export class PartialApplyError<Summary = unknown>
  extends Error
  implements PartialApplyFailure<Summary>
{
  readonly directory: string;
  readonly applied: readonly Summary[];
  readonly notApplied: readonly Summary[];
  readonly created: PartialApplyCreate | null;

  constructor(failure: PartialApplyFailure<Summary>, cause: unknown) {
    super(failure.message, { cause });
    this.name = 'PartialApplyError';
    this.directory = failure.directory;
    this.applied = failure.applied;
    this.notApplied = failure.notApplied;
    this.created = failure.created;
  }
}

const bulletList = (lines: readonly string[]) =>
  lines.length === 0 ? '- none' : lines.map((line) => `- ${line}`).join('\n');

const failureMessage = <Summary>(
  options: ApplyRunner<Summary>,
  failure: Omit<PartialApplyFailure<Summary>, 'message'>,
  cause: unknown,
) => {
  const applied = bulletList(failure.applied.map(options.describe));
  const notApplied = bulletList(failure.notApplied.map(options.describe));

  return `A step failed: ${errorMessage(cause)}\nApplied:\n${applied}\nNot applied:\n${notApplied}\nThe draft is in ${failure.directory}. Read it again before a retry.`;
};

const partialApplyError = <Summary>(
  options: ApplyRunner<Summary>,
  failure: Omit<PartialApplyFailure<Summary>, 'message'>,
  cause: unknown,
): PartialApplyError<Summary> =>
  new PartialApplyError({ ...failure, message: failureMessage(options, failure, cause) }, cause);

const failureAt = <Summary>(
  options: ApplyRunner<Summary>,
  applied: readonly Summary[],
  summaries: readonly Summary[],
  index: number,
  error: unknown,
): Omit<PartialApplyFailure<Summary>, 'message'> => {
  const failedStep = summaries[index];

  if (!(error instanceof CreatedButNotRecordedError)) {
    return {
      directory: options.directory(),
      applied,
      notApplied: summaries.slice(index),
      created: null,
    };
  }

  const { created } = error;
  const appliedWithCreate = failedStep === undefined ? applied : [...applied, failedStep];

  return {
    directory: options.directory(),
    applied: appliedWithCreate,
    notApplied: [options.recordIdentifier(created), ...summaries.slice(index + 1)],
    created,
  };
};

export const runApplySteps = async <Summary>(
  options: ApplyRunner<Summary>,
  applied: readonly Summary[],
  steps: readonly PartialApplyStep<Summary>[],
): Promise<Summary[]> => {
  const summaries = steps.map((step) => step.summary);
  const done = [...applied];

  for (const [index, step] of steps.entries()) {
    if (options.signal?.aborted === true) {
      throw partialApplyError(
        options,
        {
          directory: options.directory(),
          applied: done,
          notApplied: summaries.slice(index),
          created: null,
        },
        new Error('The call was aborted.'),
      );
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- Steps run in plan order, and a create records its identifier before the next step.
      await step.run();
    } catch (error) {
      throw partialApplyError(options, failureAt(options, done, summaries, index, error), error);
    }

    done.push(step.summary);
  }

  return done;
};

export const failPartialApply = <Summary>(
  options: ApplyRunner<Summary>,
  applied: readonly Summary[],
  error: unknown,
): never => {
  throw partialApplyError(
    options,
    { directory: options.directory(), applied, notApplied: [], created: null },
    error,
  );
};

export const partialApplyToolResult = <Summary>(
  failure: PartialApplyFailure<Summary>,
): {
  content: { type: 'text'; text: string }[];
  details: PartialApplyFailureDetails<Summary>;
  isError: true;
} => {
  const details: PartialApplyFailureDetails<Summary> = {
    status: 'failed',
    error: failure.message,
    directory: failure.directory,
    applied: failure.applied,
    notApplied: failure.notApplied,
    created: failure.created,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }],
    details,
    isError: true,
  };
};
