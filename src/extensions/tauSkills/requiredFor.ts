interface SkillFrontmatterFacts {
  name: string;
  filePath: string;
  frontmatter: Record<string, unknown>;
}

interface RequiredAction {
  name: string;
  action: string;
}

const requiredForKey = 'metadata.required-for';

const isMap = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

const metadataOf = (skill: SkillFrontmatterFacts): Record<string, unknown> | undefined => {
  const { metadata } = skill.frontmatter;

  if (metadata === undefined) {
    return undefined;
  }

  if (!isMap(metadata)) {
    throw new TypeError(`${skill.filePath}: \`metadata\` must be a map.`);
  }

  return metadata;
};

const requiredForOf = (skill: SkillFrontmatterFacts): string | undefined => {
  const value = metadataOf(skill)?.['required-for'];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new TypeError(`${skill.filePath}: \`${requiredForKey}\` must be a string.`);
  }

  if (value.trim() === '') {
    throw new Error(`${skill.filePath}: \`${requiredForKey}\` must not be empty.`);
  }

  return value.trim();
};

export const requiredActions = (skills: readonly SkillFrontmatterFacts[]): RequiredAction[] =>
  skills.flatMap((skill) => {
    const action = requiredForOf(skill);

    return action === undefined ? [] : [{ name: skill.name, action }];
  });
