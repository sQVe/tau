const quotedEscapes: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

const octalLength = 3;

const octalEscape = /^[0-7]{3}/;

// Reads a Git C-style quoted name that starts at text[0], a double quote. Returns the name and the
// text after the closing quote.
export const readQuoted = (text: string): { name: string; rest: string } => {
  const bytes: number[] = [];
  let index = 1;

  while (index < text.length && text[index] !== '"') {
    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const octal = octalEscape.exec(text.slice(index + 1))?.[0];
    const escaped = quotedEscapes[text[index + 1] ?? ''];

    if (character !== '\\') {
      bytes.push(...Buffer.from(character));
      index += character.length;
    } else if (octal === undefined) {
      bytes.push(escaped ?? 0);
      index += 2;
    } else {
      bytes.push(Number.parseInt(octal, 8));
      index += octalLength + 1;
    }
  }

  return { name: Buffer.from(bytes).toString('utf8'), rest: text.slice(index + 1) };
};
