import { readQuoted } from './gitQuotedName.js';

export type SupportedMode = '100644' | '100755';

export type ShownMode = SupportedMode | 'symlink' | 'gitlink' | 'unreadable';

export interface ShownFile {
  blob: string | undefined;
  source: string;
  // A copy leaves its source in place, so only a rename source may disappear.
  copied: boolean;
  mode: ShownMode | undefined;
}

const shownModes = new Map<string, ShownMode>([
  ['100644', '100644'],
  ['100755', '100755'],
  ['120000', 'symlink'],
  ['160000', 'gitlink'],
]);

const parseMode = (text: string): ShownMode => shownModes.get(text) ?? 'unreadable';

export const isSupportedMode = (mode: ShownMode): mode is SupportedMode =>
  mode === '100644' || mode === '100755';

const separatorLength = 5;

const headerPrefix = 'diff --git ';

const headerPath = (line: string): string | undefined => {
  const text = line.slice(headerPrefix.length);

  if (text.startsWith('"')) {
    const first = readQuoted(text);
    const second = first.rest.slice(1);
    const secondName = second.startsWith('"') ? readQuoted(second).name : second;

    return first.name.slice(2) === secondName.slice(2) ? secondName.slice(2) : undefined;
  }

  const pathLength = (text.length - separatorLength) / 2;
  const path = text.slice(text.length - pathLength);

  return Number.isInteger(pathLength) && text === `a/${path} b/${path}` ? path : undefined;
};

const indexLine = /^index [0-9a-f]+\.\.([0-9a-f]+)(?: (\S+))?$/;

const newModeLine = /^new (?:file )?mode (\S+)$/;

const parseName = (text: string) => (text.startsWith('"') ? readQuoted(text).name : text);

const renameTarget = /^(?:rename|copy) to (.*)$/;

const renameSource = /^(rename|copy) from (.*)$/;

const applyBlobLine = (entry: ShownFile, line: string) => {
  const index = indexLine.exec(line);
  const modeText = newModeLine.exec(line)?.[1] ?? index?.[2];

  entry.blob ??= index?.[1];

  if (modeText !== undefined) {
    entry.mode ??= parseMode(modeText);
  }
};

const applyLine = (shown: Map<string, ShownFile>, entry: ShownFile, line: string) => {
  const source = renameSource.exec(line);
  const toName = renameTarget.exec(line)?.[1];

  if (source !== null) {
    entry.source = parseName(source[2] ?? '');
    entry.copied = source[1] === 'copy';
  } else if (toName !== undefined) {
    shown.set(parseName(toName), entry);
  } else {
    applyBlobLine(entry, line);
  }
};

export const shownBlobs = (text: string): Map<string, ShownFile> => {
  const shown = new Map<string, ShownFile>();
  let entry: ShownFile | undefined;

  for (const line of text.split('\n')) {
    if (line.startsWith(headerPrefix)) {
      const path = headerPath(line);

      entry = { blob: undefined, source: path ?? '', copied: false, mode: undefined };

      if (path !== undefined) {
        shown.set(path, entry);
      }
    } else if (entry !== undefined) {
      applyLine(shown, entry, line);
    }
  }

  return shown;
};
