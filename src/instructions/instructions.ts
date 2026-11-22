import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codingSetText } from './guideRuns.js';
import type { GuideRuns } from './guideRuns.js';

type InstructionFileName = Exclude<InstructionSetName, 'coding'>;

export type InstructionSection = { kind: 'file'; text: string } | { kind: 'coding' };

export const bundledInstructionsDirectory = fileURLToPath(new URL('./', import.meta.url));

export const instructionSetNames = ['writing', 'coding', 'workflow', 'browser'] as const;

export type InstructionSetName = (typeof instructionSetNames)[number];

// A profile without `instruction-sets:` loads these. Browser rules are opt-in.
export const defaultInstructionSetNames: InstructionSetName[] = ['writing', 'coding', 'workflow'];

export const isInstructionSetName = (name: string): name is InstructionSetName =>
  instructionSetNames.some((setName) => setName === name);

export const readInstructionSet = async (
  name: InstructionFileName,
  directory: string,
): Promise<string> => {
  const path = join(directory, `${name}.md`);
  const instructions = await readFile(path, 'utf8');

  const trimmedInstructions = instructions.trim();

  if (!trimmedInstructions) {
    throw new Error(`The ${name} instructions are empty: ${path}`);
  }

  return trimmedInstructions;
};

export const readInstructionSections = (
  names: readonly InstructionSetName[],
  directory: string,
): Promise<InstructionSection[]> => {
  const selected = instructionSetNames.filter((name) => names.includes(name));

  return Promise.all(
    selected.map(async (name): Promise<InstructionSection> => {
      if (name === 'coding') {
        return { kind: 'coding' };
      }

      return { kind: 'file', text: await readInstructionSet(name, directory) };
    }),
  );
};

const needsGuides = (sections: readonly InstructionSection[]): boolean =>
  sections.some((section) => section.kind === 'coding');

export const instructionTexts = async (
  sections: readonly InstructionSection[],
  guideRuns: Pick<GuideRuns, 'snapshot'>,
): Promise<string[]> => {
  const codingText = needsGuides(sections) ? codingSetText(await guideRuns.snapshot()) : '';

  return sections.map((section) => (section.kind === 'coding' ? codingText : section.text));
};
