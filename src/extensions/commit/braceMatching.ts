// The index of the `}` that matches the `{` at `openIndex`, counting nested braces.
export const matchingBrace = (word: string, openIndex: number): number | undefined => {
  let depth = 0;

  for (let index = openIndex; index < word.length; index += 1) {
    const character = word[index];

    if (character === '{') {
      depth += 1;

      continue;
    }

    if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
};
