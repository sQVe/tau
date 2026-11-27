import { basename } from 'node:path';

const executableNames = (name: string, suffixes: readonly string[]): string[] => [
  name,
  ...suffixes.map((suffix) => `${name}.${suffix}`),
];

const piExecutableSuffixes = ['cmd', 'js', 'exe'];

// `baseName` strips a `.exe` suffix, so the set holds only the names it can return.
const piExecutableNames = new Set(executableNames('pi', ['cmd', 'js']));

const runtimeExecutables = new Set(['node', 'bun']);

// The name a word runs, without its directory and suffix, so `BASH.EXE` and `bash` compare equal.
export const baseName = (argument: string): string => {
  const name = basename(argument.replaceAll('\\', '/')).toLowerCase();

  return name.endsWith('.exe') ? name.slice(0, -'.exe'.length) : name;
};

const isPiExecutable = (argument: string | undefined): boolean =>
  argument !== undefined && piExecutableNames.has(baseName(argument));

const carriesPath = (argument: string): boolean =>
  argument.includes('/') || argument.includes('\\');

const hasExecutableSuffix = (argument: string): boolean =>
  piExecutableSuffixes.some((suffix) => argument.toLowerCase().endsWith(`.${suffix}`));

const isPathShaped = (argument: string): boolean =>
  carriesPath(argument) || hasExecutableSuffix(argument);

// An inline-program flag supplies the program itself, so no script follows it.
const inlineProgramRuntimeFlags = new Set(['--eval', '-e', '--print', '-p']);

// A long inline-program flag may carry its program after `=`, as in `--eval=code`, and a short one
// may carry it attached, as in `-ecode`.
const isInlineProgramFlag = (argument: string): boolean => {
  if (inlineProgramRuntimeFlags.has(argument)) {
    return true;
  }

  const attachedShortFlag = argument.slice(0, 2);

  const hasAttachedShortProgram =
    argument.length > 2 && inlineProgramRuntimeFlags.has(attachedShortFlag);

  if (hasAttachedShortProgram) {
    return true;
  }

  const equalsIndex = argument.indexOf('=');

  if (equalsIndex === -1) {
    return false;
  }

  const flagName = argument.slice(0, equalsIndex);

  return flagName.startsWith('--') && inlineProgramRuntimeFlags.has(flagName);
};

// A partial allowlist of runtime flags that take a separate value, so the next argument is a flag
// value and not the script. A bare Pi name counts only when it is the first candidate after the
// skipped values; a later Pi name needs a path separator or an executable suffix.
const valueTakingRuntimeFlags = new Set([
  '--conditions',
  '-C',
  '--dns-result-order',
  '--env-file',
  '--experimental-loader',
  '--icu-data-dir',
  '--import',
  '--inspect-port',
  '--loader',
  '--max-http-header-size',
  '--max-old-space-size',
  '--openssl-config',
  '--preload',
  '--redirect-warnings',
  '--require',
  '-r',
  '--stack-size',
  '--title',
  '--tls-cipher-list',
  '--watch-path',
]);

// Returns the index of the argument after the flag and after its value when the flag takes one.
const skipRuntimeFlagValue = (argument: string, index: number): number =>
  valueTakingRuntimeFlags.has(argument) ? index + 2 : index + 1;

// The script is the first argument after the runtime once the known flag values are skipped. A
// later Pi name counts only when it carries a path separator or an executable suffix.
const scriptArgument = (argv: readonly string[]): string | undefined => {
  let isFirstCandidate = true;
  let index = 1;

  while (index < argv.length) {
    const argument = argv[index];

    if (argument === undefined) {
      return undefined;
    }

    if (argument.startsWith('-')) {
      if (isInlineProgramFlag(argument)) {
        return undefined;
      }

      index = skipRuntimeFlagValue(argument, index);

      continue;
    }

    const isScript = isFirstCandidate || isPathShaped(argument);

    if (isPiExecutable(argument) && isScript) {
      return argument;
    }

    isFirstCandidate = false;
    index += 1;
  }

  return undefined;
};

export const piArgv = (argv: readonly string[] | undefined): readonly string[] | undefined => {
  if (argv === undefined) {
    return undefined;
  }

  const [first] = argv;

  if (isPiExecutable(first)) {
    return argv;
  }

  const runtime = first === undefined ? undefined : baseName(first);

  if (runtime === undefined || !runtimeExecutables.has(runtime)) {
    return undefined;
  }

  return isPiExecutable(scriptArgument(argv)) ? argv : undefined;
};
