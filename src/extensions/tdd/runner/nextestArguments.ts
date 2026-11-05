import type { CargoMetadata } from './cargoMetadata.js';

interface RunRequest {
  profileName: string;
  toolConfigPath: string;
  targets: readonly string[];
  testNames?: readonly string[];
  binaryIds?: readonly string[];
}

const escapeFilterName = (name: string) => name.replace(/[\\),]/g, '\\$&');

const nameFilter = (testNames: readonly string[]): string =>
  testNames.map((name) => `test(=${escapeFilterName(name)})`).join(' | ');

const binaryFilter = (binaryIds: readonly string[]): string => {
  const terms = binaryIds.map((binaryId) => `binary_id(${escapeFilterName(binaryId)})`);

  return terms.length === 1 ? (terms[0] ?? '') : `(${terms.join(' | ')})`;
};

const selectionFilter = (testNames: readonly string[], binaryIds: readonly string[]): string => {
  if (binaryIds.length === 0) {
    return nameFilter(testNames);
  }

  const names = testNames.length > 1 ? `(${nameFilter(testNames)})` : nameFilter(testNames);

  return `${binaryFilter(binaryIds)} & ${names}`;
};

const hasLibrary = (metadata: CargoMetadata): boolean =>
  metadata.targets.some(
    (target) => target.kinds.includes('lib') || target.kinds.includes('proc-macro'),
  );

export const targetArguments = (metadata: CargoMetadata): string[] => [
  '--workspace',
  ...(hasLibrary(metadata) ? ['--lib'] : []),
  '--bins',
  '--tests',
];

export const listArguments = (targets: readonly string[]): string[] => [
  'nextest',
  'list',
  ...targets,
  '--message-format',
  'json',
];

export const metadataArguments = (): string[] => ['metadata', '--no-deps', '--format-version', '1'];

export const runArguments = ({
  profileName,
  toolConfigPath,
  targets,
  testNames,
  binaryIds = [],
}: RunRequest): string[] => {
  const argumentsList = [
    'nextest',
    'run',
    ...targets,
    '--tool-config-file',
    `tau:${toolConfigPath}`,
    '--profile',
    profileName,
    '--no-fail-fast',
    '--ignore-default-filter',
  ];

  if (testNames !== undefined) {
    argumentsList.push('-E', selectionFilter(testNames, binaryIds));
  }

  return argumentsList;
};

export const toolConfig = (profileName: string, junitPath: string): string =>
  [
    `[profile.${profileName}]`,
    'fail-fast = false',
    '',
    `[profile.${profileName}.junit]`,
    `path = ${JSON.stringify(junitPath)}`,
    '',
  ].join('\n');
