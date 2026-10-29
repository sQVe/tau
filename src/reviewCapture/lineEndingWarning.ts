// Git prints one of these on stderr for each file whose line endings it converts. Its text names
// the direction of the conversion, so both directions are listed. Git prints the file name as is,
// so the name may hold a quote or a newline, and a warning may span several lines.
const lineEndingWarnings =
  /(?<=^|\n)[ \t]*warning: in the working copy of '[\s\S]+?', (?:CRLF will be replaced by LF|LF will be replaced by CRLF) the next time Git touches it(?=[ \t]*(?:\n|$))/g;

// True when stderr holds nothing but blank space and line-ending warnings. Any other text means Git
// reported a problem that the capture must not ignore.
export const hasOnlyLineEndingWarnings = (stderr: string): boolean =>
  stderr.replaceAll(lineEndingWarnings, '').trim() === '';
