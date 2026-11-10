// Decides the summary the manager receives for a worker report.
// tests/structure.test.ts keeps this module pure.

export interface SummaryLengthFacts {
  summary: string;
  // The file that holds the full summary when it passes the limit.
  file: string;
}

export const summaryLengthLimit = 3000;

const formatCount = (count: number): string => count.toLocaleString('en-US');

const cutNote = (file: string, cutCharacters: number): string =>
  `Full summary in ${file}; ${formatCount(cutCharacters)} characters cut.`;

const withNote = (summary: string, kept: string, file: string): string =>
  `${kept}\n${cutNote(file, summary.length - kept.length)}`;

// Returns the summary unchanged within the limit. Otherwise it keeps the text before the last line
// break that leaves room for the note, so the result with the note stays within the limit. Without
// such a line break it cuts mid-line.
export const shortenSummary = ({ summary, file }: SummaryLengthFacts): string => {
  if (summary.length <= summaryLengthLimit) {
    return summary;
  }

  let lineBreak = summary.lastIndexOf('\n', summaryLengthLimit);

  while (lineBreak > 0) {
    const shortened = withNote(summary, summary.slice(0, lineBreak), file);

    if (shortened.length <= summaryLengthLimit) {
      return shortened;
    }

    lineBreak = summary.lastIndexOf('\n', lineBreak - 1);
  }

  const widestNote = cutNote(file, summary.length);
  const budget = Math.max(0, summaryLengthLimit - widestNote.length - 1);

  return withNote(summary, summary.slice(0, budget), file);
};
