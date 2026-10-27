import { readQuoted } from './gitQuotedName.js';

export type SupportedMode = '100644' | '100755';

export type ShownMode = SupportedMode | 'symlink' | 'gitlink' | 'unreadable';

export interface ShownFile {
  // The blob after the change, from the index line. Undefined for a mode-only change or a 100% rename.
  blob: string | undefined;
  // The path whose base blob the saved copy matches when no index line shows one.
  source: string;
  // The mode after the change. Undefined for a deletion or a rename that keeps the mode.
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

// `a/`, ` b/` and the two slashes around the repeated path.
const separatorLength = 5;

const headerPrefix = 'diff --git ';

// The new-side path of a `diff --git a/<path> b/<path>` header, quoted or not. Undefined for a
// header that names two different paths, such as a rename.
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

// The blob each captured file section shows for the new side. Undefined for a section with no
// index line, such as a mode-only change. The index line also shows the mode when the change keeps
// it.
const indexLine = /^index [0-9a-f]+\.\.([0-9a-f]+)(?: (\S+))?$/;

const newModeLine = /^new (?:file )?mode (\S+)$/;

const parseName = (text: string) => (text.startsWith('"') ? readQuoted(text).name : text);

const renameTarget = /^(?:rename|copy) to (.*)$/;

const renameSource = /^(?:rename|copy) from (.*)$/;

const applyLine = (shown: Map<string, ShownFile>, entry: ShownFile, line: string) => {
  const fromName = renameSource.exec(line)?.[1];
  const toName = renameTarget.exec(line)?.[1];

  if (fromName !== undefined) {
    entry.source = parseName(fromName);
  } else if (toName !== undefined) {
    shown.set(parseName(toName), entry);
  } else {
    const index = indexLine.exec(line);
    const modeText = newModeLine.exec(line)?.[1] ?? index?.[2];

    entry.blob ??= index?.[1];

    if (modeText !== undefined) {
      entry.mode ??= parseMode(modeText);
    }
  }
};

// The new-side file each section of the captured diff shows, keyed by its path. A rename or copy
// header names two paths, so its section is keyed by the `rename to` or `copy to` line.
export const shownBlobs = (text: string): Map<string, ShownFile> => {
  const shown = new Map<string, ShownFile>();
  let entry: ShownFile | undefined;

  for (const line of text.split('\n')) {
    if (line.startsWith(headerPrefix)) {
      const path = headerPath(line);

      entry = { blob: undefined, source: path ?? '', mode: undefined };

      if (path !== undefined) {
        shown.set(path, entry);
      }
    } else if (entry !== undefined) {
      applyLine(shown, entry, line);
    }
  }

  return shown;
};
