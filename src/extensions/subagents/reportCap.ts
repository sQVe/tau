export interface CappedReportText {
  summary: string;
  evidence: string[];
}

const reportCharacterCap = 8000;

const summaryCutMarker = '\n[…]\n';

// Cuts before a split surrogate pair so the result stays valid text.
const cut = (text: string, length: number): string =>
  text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(length - 1)) ? length - 1 : length);

// Concerns come last in a summary, so a long one keeps its start and its end.
const cutSummary = (summary: string): string => {
  if (summary.length <= reportCharacterCap) {
    return summary;
  }

  const room = reportCharacterCap - summaryCutMarker.length;
  const head = Math.floor(room / 2);
  const tail = summary.slice(summary.length - (room - head));

  return `${cut(summary, head)}${summaryCutMarker}${tail.replace(/^[\uDC00-\uDFFF]/, '')}`;
};

export const capReportText = (
  summary: string,
  evidence: readonly string[],
): CappedReportText | undefined => {
  const size = evidence.reduce((total, entry) => total + entry.length, summary.length);

  if (size <= reportCharacterCap) {
    return undefined;
  }

  let remaining = reportCharacterCap - Math.min(summary.length, reportCharacterCap);
  const kept: string[] = [];

  for (const entry of evidence) {
    if (remaining <= 0) {
      break;
    }

    kept.push(cut(entry, remaining));
    remaining -= entry.length;
  }

  return { summary: cutSummary(summary), evidence: kept };
};
