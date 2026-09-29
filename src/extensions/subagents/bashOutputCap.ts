export interface CutBashOutput {
  head: string;
  tail: string;
  cut: number;
}

const outputCap = 8000;
const headLength = 2000;
const tailLength = 5500;

// Drops half of a surrogate pair split by a character cut, so the kept text stays valid.
const keepHead = (text: string): string => {
  const window = text.slice(0, headLength);
  const lineEnd = window.lastIndexOf('\n');

  if (lineEnd >= headLength / 2) {
    return window.slice(0, lineEnd);
  }

  return window.replace(/[\uD800-\uDBFF]$/u, '');
};

const keepTail = (text: string): string => {
  const window = text.slice(-tailLength);
  const lineStart = window.indexOf('\n');

  if (lineStart !== -1 && window.length - lineStart - 1 >= tailLength / 2) {
    return window.slice(lineStart + 1);
  }

  return window.replace(/^[\uDC00-\uDFFF]/u, '');
};

// Keeps whole lines unless one long line would leave the head or tail under half its room.
export const cutBashOutput = (text: string): CutBashOutput | undefined => {
  if (text.length <= outputCap) {
    return undefined;
  }

  const head = keepHead(text);
  const tail = keepTail(text);

  return { head, tail, cut: text.length - head.length - tail.length };
};
