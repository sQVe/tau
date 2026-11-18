export interface StartupFacts {
  argv: readonly string[];
  stdinIsTerminal: boolean;
  stdoutIsTerminal: boolean;
}

const reportFlags = new Set(['-p', '--print', '--mode', '--list-models']);

// A terminal session shows config problems in a notice, but a Pi mode without a UI has no notice
// sink, so the factory writes them to stderr instead.
export const shouldReportAtStartup = ({
  argv,
  stdinIsTerminal,
  stdoutIsTerminal,
}: StartupFacts): boolean =>
  !stdinIsTerminal || !stdoutIsTerminal || argv.some((argument) => reportFlags.has(argument));
