interface ArtifactHashes {
  patch: string;
  input: string;
}

export interface SavedRecord {
  version: number;
  // The Git blob hash of the saved capture.json bytes.
  identity: string;
  // Undefined for a version 1 or 2 record, which saved no original artifacts.
  recorded: ArtifactHashes | undefined;
}

export interface GenerationFacts {
  // Undefined when capture.json is missing.
  record: SavedRecord | undefined;
  // Undefined for an artifact that is missing or unreadable.
  observed: { patch: string | undefined; input: string | undefined };
  // Undefined when the caller expects no particular identity.
  expectedIdentity: string | undefined;
}

export type GenerationStatus = 'completed' | 'legacy' | 'incomplete' | 'altered' | 'missing';

export type GenerationDecision =
  | { status: 'completed'; identity: string; reasons: [] }
  | { status: Exclude<GenerationStatus, 'completed'>; reasons: string[] };

const artifactNames = ['patch', 'input'] as const;

const changedReasons = (recorded: ArtifactHashes, observed: GenerationFacts['observed']) =>
  artifactNames.flatMap((name) => {
    const hash = observed[name];

    return hash === undefined || hash === recorded[name]
      ? []
      : [`The ${name} artifact hash changed from ${recorded[name]} to ${hash}.`];
  });

const identityReasons = (identity: string, expectedIdentity: string | undefined) =>
  expectedIdentity === undefined || expectedIdentity === identity
    ? []
    : [`The capture record identity is ${identity}, not the expected ${expectedIdentity}.`];

const missingReasons = (observed: GenerationFacts['observed']) =>
  artifactNames
    .filter((name) => observed[name] === undefined)
    .map((name) => `The ${name} artifact is missing or unreadable.`);

// A proven difference outranks a missing artifact, so the altered result names both.
export const decideGeneration = ({
  record,
  observed,
  expectedIdentity,
}: GenerationFacts): GenerationDecision => {
  if (record === undefined) {
    return { status: 'incomplete', reasons: ['capture.json is missing.'] };
  }

  if (record.recorded === undefined) {
    return {
      status: 'legacy',
      reasons: [`Version ${record.version} saved no original artifacts.`],
    };
  }

  const changed = [
    ...changedReasons(record.recorded, observed),
    ...identityReasons(record.identity, expectedIdentity),
  ];

  const missing = missingReasons(observed);

  if (changed.length > 0) {
    return { status: 'altered', reasons: [...changed, ...missing] };
  }

  if (missing.length > 0) {
    return { status: 'missing', reasons: missing };
  }

  return { status: 'completed', identity: record.identity, reasons: [] };
};
