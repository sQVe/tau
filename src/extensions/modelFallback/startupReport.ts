export interface StartupFacts {
  argv: readonly string[];
  stdinIsTerminal: boolean;
  stdoutIsTerminal: boolean;
}

type AppMode = 'text' | 'json' | 'rpc';

interface ParsedArguments {
  mode?: AppMode;
  print: boolean;
  listModels: boolean;
}

// Pi consumes the next argument for these flags, so a value such as `--print` is not a flag.
const valueFlags: ReadonlySet<string> = new Set([
  '--provider',
  '--model',
  '--api-key',
  '--system-prompt',
  '--append-system-prompt',
  '--name',
  '-n',
  '--session',
  '--session-id',
  '--fork',
  '--session-dir',
  '--models',
  '--tools',
  '-t',
  '--exclude-tools',
  '-xt',
  '--thinking',
]);

const isAppMode = (value: string): value is AppMode =>
  value === 'text' || value === 'json' || value === 'rpc';

const isValue = (argument: string | undefined): argument is string =>
  argument !== undefined && !argument.startsWith('-');

const consumeMode = (argv: readonly string[], index: number, parsed: ParsedArguments): number => {
  const value = argv[index + 1];

  if (!isValue(value)) {
    return index;
  }

  if (isAppMode(value)) {
    parsed.mode = value;
  }

  return index + 1;
};

const parseArguments = (argv: readonly string[]): ParsedArguments => {
  const parsed: ParsedArguments = { print: false, listModels: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === undefined || argument === '--') {
      break;
    }

    if (argument === '--mode') {
      index = consumeMode(argv, index, parsed);

      continue;
    }

    if (argument === '--print' || argument === '-p') {
      parsed.print = true;

      continue;
    }

    if (argument === '--list-models') {
      parsed.listModels = true;

      if (isValue(argv[index + 1])) {
        index += 1;
      }

      continue;
    }

    if (valueFlags.has(argument)) {
      index += 1;
    }
  }

  return parsed;
};

// A terminal session shows config problems in a notice, but print, JSON, and list modes have no
// notice sink, so the factory writes them to stderr instead.
export const shouldReportAtStartup = ({
  argv,
  stdinIsTerminal,
  stdoutIsTerminal,
}: StartupFacts): boolean => {
  const { mode, print, listModels } = parseArguments(argv);

  if (listModels) {
    return true;
  }

  if (mode === 'rpc') {
    return false;
  }

  const streamsAreTerminals = stdinIsTerminal && stdoutIsTerminal;
  const printsWithoutUi = mode === 'json' || print;

  return printsWithoutUi || !streamsAreTerminals;
};
