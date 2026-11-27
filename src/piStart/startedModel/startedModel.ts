export type RequestedModel =
  | { kind: 'default' }
  | { kind: 'model'; provider: string | undefined; id: string };

export interface StartedModelFacts {
  requested: RequestedModel;
  argv: readonly string[];
  message: string | undefined;
}

export type StartedModelDecision =
  | { kind: 'match'; model: string }
  | { kind: 'mismatch'; requested: string; started: string }
  | { kind: 'unreadable' };

type FlagValue = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'value'; value: string };

// The first occurrence in argv order wins, so a task message that starts with `--model=` cannot
// win over the flag the launcher passed.
const flagValue = (argv: readonly string[], flag: string): FlagValue => {
  const equalsPrefix = `${flag}=`;

  for (const [index, argument] of argv.entries()) {
    if (argument === flag) {
      const value = argv[index + 1];
      // A model id may start with one dash; a double dash is the next flag, so the flag has no value.
      const usable = value !== undefined && value !== '' && !value.startsWith('--');

      return usable ? { kind: 'value', value } : { kind: 'unreadable' };
    }

    if (argument.startsWith(equalsPrefix)) {
      const value = argument.slice(equalsPrefix.length);

      return value === '' ? { kind: 'unreadable' } : { kind: 'value', value };
    }
  }

  return { kind: 'absent' };
};

const startedReference = (argv: readonly string[]): RequestedModel | 'unreadable' => {
  const provider = flagValue(argv, '--provider');
  const model = flagValue(argv, '--model');

  if (provider.kind === 'unreadable' || model.kind === 'unreadable') {
    return 'unreadable';
  }

  if (model.kind === 'absent') {
    return { kind: 'default' };
  }

  const startedProvider = provider.kind === 'value' ? provider.value : undefined;

  return { kind: 'model', provider: startedProvider, id: model.value };
};

const displayModel = (model: RequestedModel): string => {
  if (model.kind === 'default') {
    return 'default';
  }

  return model.provider === undefined ? model.id : `${model.provider}/${model.id}`;
};

const sameModel = (started: RequestedModel, requested: RequestedModel): boolean => {
  if (started.kind === 'default' || requested.kind === 'default') {
    return started.kind === requested.kind;
  }

  return started.provider === requested.provider && started.id === requested.id;
};

// The task message is the last positional argument. Only a message that starts with `-` can be read
// as a flag, so only that form is removed; a message that equals a flag value must stay.
const withoutTrailingMessage = (
  argv: readonly string[],
  message: string | undefined,
): readonly string[] => {
  const isFlagLikeMessage = message?.startsWith('-') === true && argv.at(-1) === message;

  return isFlagLikeMessage ? argv.slice(0, -1) : argv;
};

export const decideStartedModel = (facts: StartedModelFacts): StartedModelDecision => {
  const started = startedReference(withoutTrailingMessage(facts.argv, facts.message));

  if (started === 'unreadable') {
    return { kind: 'unreadable' };
  }

  const matches = sameModel(started, facts.requested);

  return matches
    ? { kind: 'match', model: displayModel(started) }
    : {
        kind: 'mismatch',
        requested: displayModel(facts.requested),
        started: displayModel(started),
      };
};
