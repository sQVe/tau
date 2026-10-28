interface ArtifactHashes {
  patch: string;
  input: string;
  snapshot?: string;
}

type ArtifactName = keyof ArtifactHashes;

export interface SavedRecord {
  version: number;
  identity: string;
  recorded: ArtifactHashes | undefined;
}

type EndpointStatus = 'complete' | 'unsupported' | 'incomplete';

export interface EndpointFacts {
  status: EndpointStatus;
  missing: string[];
  mismatches: string[];
}

export interface GenerationFacts {
  record: SavedRecord | undefined;
  observed: Record<ArtifactName, string | undefined>;
  endpoint: EndpointFacts | undefined;
  expectedIdentity: string | undefined;
}

export type GenerationStatus = 'completed' | 'legacy' | 'incomplete' | 'altered' | 'missing';

export type GenerationDecision =
  | { status: 'completed'; identity: string; reasons: []; endpoint?: EndpointStatus }
  | { status: Exclude<GenerationStatus, 'completed'>; reasons: string[] };

const recordedNames = (recorded: ArtifactHashes): ArtifactName[] =>
  recorded.snapshot === undefined ? ['patch', 'input'] : ['patch', 'input', 'snapshot'];

const changedReasons = (recorded: ArtifactHashes, observed: GenerationFacts['observed']) =>
  recordedNames(recorded).flatMap((name) => {
    const hash = observed[name];

    return hash === undefined || hash === recorded[name]
      ? []
      : [`The ${name} artifact hash changed from ${recorded[name]} to ${hash}.`];
  });

const identityReasons = (identity: string, expectedIdentity: string | undefined) =>
  expectedIdentity === undefined || expectedIdentity === identity
    ? []
    : [`The capture record identity is ${identity}, not the expected ${expectedIdentity}.`];

const missingReasons = (recorded: ArtifactHashes, observed: GenerationFacts['observed']) =>
  recordedNames(recorded)
    .filter((name) => observed[name] === undefined)
    .map((name) => `The ${name} artifact is missing or unreadable.`);

const completed = (identity: string, endpoint: EndpointFacts | undefined): GenerationDecision =>
  endpoint === undefined
    ? { status: 'completed', identity, reasons: [] }
    : { status: 'completed', identity, reasons: [], endpoint: endpoint.status };

export const decideGeneration = ({
  record,
  observed,
  endpoint,
  expectedIdentity,
}: GenerationFacts): GenerationDecision => {
  if (record === undefined) {
    return { status: 'incomplete', reasons: ['capture.json is missing.'] };
  }

  const otherIdentity = identityReasons(record.identity, expectedIdentity);

  if (otherIdentity.length > 0 && record.recorded === undefined) {
    return { status: 'altered', reasons: otherIdentity };
  }

  if (record.recorded === undefined) {
    return {
      status: 'legacy',
      reasons: [`Version ${record.version} saved no original artifacts.`],
    };
  }

  const changed = [
    ...changedReasons(record.recorded, observed),
    ...otherIdentity,
    ...(endpoint?.mismatches ?? []),
  ];

  const missing = [...missingReasons(record.recorded, observed), ...(endpoint?.missing ?? [])];

  if (changed.length > 0) {
    return { status: 'altered', reasons: [...changed, ...missing] };
  }

  if (missing.length > 0) {
    return { status: 'missing', reasons: missing };
  }

  return completed(record.identity, endpoint);
};
