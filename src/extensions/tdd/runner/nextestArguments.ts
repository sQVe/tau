interface RunRequest {
  profileName: string;
  toolConfigPath: string;
  testNames?: readonly string[];
}

const scopeArguments = ['--workspace', '--lib', '--bins', '--tests'];

const escapeFilterName = (name: string) => name.replace(/[\\),]/g, '\\$&');

const nameFilter = (testNames: readonly string[]): string =>
  testNames.map((name) => `test(=${escapeFilterName(name)})`).join(' | ');

export const listArguments = (): string[] => [
  'nextest',
  'list',
  ...scopeArguments,
  '--message-format',
  'json',
];

export const runArguments = ({ profileName, toolConfigPath, testNames }: RunRequest): string[] => {
  const argumentsList = [
    'nextest',
    'run',
    ...scopeArguments,
    '--tool-config-file',
    `tau:${toolConfigPath}`,
    '--profile',
    profileName,
    '--no-fail-fast',
    '--ignore-default-filter',
  ];

  if (testNames !== undefined) {
    argumentsList.push('-E', nameFilter(testNames));
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
