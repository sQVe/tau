export interface RequestedModel {
  provider: string | undefined;
  id: string | undefined;
}

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
      const usable = value !== undefined && value !== '' && !value.startsWith('-');

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
    return { provider: undefined, id: undefined };
  }

  const startedProvider = provider.kind === 'value' ? provider.value : undefined;

  return {
    provider: startedProvider,
    id: model.value,
  };
};

const displayModel = ({ provider, id }: RequestedModel): string => {
  if (id === undefined) {
    return 'default';
  }

  return provider === undefined ? id : `${provider}/${id}`;
};

// The task message is the last positional argument, so a message that starts with a model flag is
// not the flag the launcher passed.
const withoutTrailingMessage = (
  argv: readonly string[],
  message: string | undefined,
): readonly string[] =>
  message !== undefined && argv.at(-1) === message ? argv.slice(0, -1) : argv;

export const decideStartedModel = (facts: StartedModelFacts): StartedModelDecision => {
  const started = startedReference(withoutTrailingMessage(facts.argv, facts.message));

  if (started === 'unreadable') {
    return { kind: 'unreadable' };
  }

  const matches =
    started.provider === facts.requested.provider && started.id === facts.requested.id;

  return matches
    ? { kind: 'match', model: displayModel(started) }
    : {
        kind: 'mismatch',
        requested: displayModel(facts.requested),
        started: displayModel(started),
      };
};
