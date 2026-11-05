const ruleWithSources = (line: string): boolean => line.includes(': ');

const sourcePaths = (prerequisites: string): string[] => {
  const paths: string[] = [];
  let path = '';

  for (let index = 0; index < prerequisites.length; index += 1) {
    const character = prerequisites[index];

    if (character === '\\' && prerequisites[index + 1] === ' ') {
      path += ' ';
      index += 1;
    } else if (character === ' ') {
      if (path !== '') {
        paths.push(path);
      }

      path = '';
    } else {
      path += character;
    }
  }

  if (path !== '') {
    paths.push(path);
  }

  return paths;
};

export const parseRustDepInfo = (text: string): string[] | null => {
  const rule = text.split('\n').find(ruleWithSources);

  if (rule === undefined) {
    return null;
  }

  const prerequisites = rule.slice(rule.indexOf(': ') + ': '.length).trim();

  return prerequisites === '' ? null : sourcePaths(prerequisites);
};
