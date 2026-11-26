export interface RequestedModel {
  provider: string | undefined;
  id: string | undefined;
}

export interface StartedModelFacts {
  requested: RequestedModel;
  // Undefined means no Pi foreground process was readable.
  argv: readonly string[] | undefined;
}

export type StartedModelDecision =
  | { kind: 'match'; model: string }
  | { kind: 'mismatch'; requested: string; started: string }
  | { kind: 'unreadable' };

const valueAfter = (argv: readonly string[], flag: string): string | undefined => {
  const equalsPrefix = `${flag}=`;
  const equalsArgument = argv.find((argument) => argument.startsWith(equalsPrefix));

  if (equalsArgument !== undefined) {
    return equalsArgument.slice(equalsPrefix.length);
  }

  const index = argv.indexOf(flag);

  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];

  return value === undefined || value.startsWith('-') ? undefined : value;
};

const startedReference = (argv: readonly string[]): RequestedModel => {
  const id = valueAfter(argv, '--model');

  if (id === undefined) {
    return { provider: undefined, id: undefined };
  }

  return { provider: valueAfter(argv, '--provider'), id };
};

const displayModel = ({ provider, id }: RequestedModel): string => {
  if (id === undefined) {
    return 'default';
  }

  return provider === undefined ? id : `${provider}/${id}`;
};

export const decideStartedModel = (facts: StartedModelFacts): StartedModelDecision => {
  if (facts.argv === undefined) {
    return { kind: 'unreadable' };
  }

  const started = startedReference(facts.argv);

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
