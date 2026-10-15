import type { QaSettings } from './qaSettings.js';

export interface UrlCommandRun {
  command: string;
  source: string;
  // Undefined when the command could not run, failed, or ran past its timeout.
  stdout: string | undefined;
}

export type UrlCommandResult = { url: string } | { refusal: string };

const isHttpUrl = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }

  const { protocol } = new URL(value);

  return protocol === 'http:' || protocol === 'https:';
};

export const urlCommandResult = ({ command, source, stdout }: UrlCommandRun): UrlCommandResult => {
  const named = `qa.repositories urlCommand ${JSON.stringify(command)} in ${source}`;

  if (stdout === undefined) {
    return { refusal: `Launch refused: the ${named} failed or timed out.` };
  }

  const url = stdout.trim();

  if (url === '') {
    return { refusal: `Launch refused: the ${named} printed no URL.` };
  }

  if (!isHttpUrl(url)) {
    return {
      refusal: `Launch refused: the ${named} printed ${JSON.stringify(url)}, which is not an http or https URL.`,
    };
  }

  return { url };
};

// The worker runs the test account command itself, so its output never reaches the manager.
export const qaBriefLines = (settings: QaSettings): string[] => {
  const lines: string[] = [];

  if (settings.testAccountCommand !== undefined) {
    lines.push(`Test account: run \`${settings.testAccountCommand}\` to read it.`);
  }

  lines.push(
    settings.dataWrites
      ? 'Data writes: allowed in the dev database.'
      : 'Data writes: not allowed in the dev database.',
  );

  return lines;
};

export const briefWithQaLines = (brief: string, lines: string[]): string =>
  lines.length === 0 ? brief : `${brief}\n\n${lines.join('\n')}`;
