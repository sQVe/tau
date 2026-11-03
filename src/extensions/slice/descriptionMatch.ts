interface Fence {
  character: string;
  length: number;
}

const openingFence = (line: string): Fence | undefined => {
  const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];

  return marker === undefined ? undefined : { character: marker.charAt(0), length: marker.length };
};

const closesFence = (line: string, fence: Fence) => {
  const marker = /^\s*(`{3,}|~{3,})\s*$/u.exec(line)?.[1];

  return marker?.[0] === fence.character && marker.length >= fence.length;
};

// Linear rewrites a "- " list item as "* ", so compare descriptions without the marker.
// Lines inside a fenced code block stay as they are.
const withoutListMarkers = (description: string) => {
  let fence: Fence | undefined;

  const lines = description.split('\n').map((line) => {
    if (fence !== undefined) {
      fence = closesFence(line, fence) ? undefined : fence;

      return line;
    }

    fence = openingFence(line);

    if (fence !== undefined) {
      return line;
    }

    return line.replace(/^(\s*)[*-] /u, '$1- ');
  });

  return lines.join('\n');
};

export const sameDescription = (saved: string, body: string | undefined): boolean =>
  body !== undefined && withoutListMarkers(saved) === withoutListMarkers(body);
