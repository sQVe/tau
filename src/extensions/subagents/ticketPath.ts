// Finds the ticket file a launch brief names. tests/structure.test.ts keeps this module pure.

// Words end at whitespace, quotes, and brackets, so a path may not contain spaces. The search runs
// before the classifier limit can stop it, so it splits once instead of using a backtracking pattern.
const wordSeparator = /[\s`'"()<>[\]]+/;

const sentencePunctuation = /^[.,;:!?]*$/;

const ticketInWord = (word: string): string | undefined => {
  const extension = word.lastIndexOf('.md');

  if (extension === -1) {
    return undefined;
  }

  const end = extension + '.md'.length;
  const path = word.slice(0, end);

  if (!path.includes('.tau/slices/')) {
    return undefined;
  }

  if (!sentencePunctuation.test(word.slice(end))) {
    return undefined;
  }

  return path;
};

// Returns the first `.tau/slices/**/*.md` path in the brief, as written.
export const findTicketPath = (brief: string): string | undefined => {
  for (const word of brief.split(wordSeparator)) {
    const path = ticketInWord(word);

    if (path !== undefined) {
      return path;
    }
  }

  return undefined;
};
