import { readFile } from 'node:fs/promises';

export const instructionSetNames = ['writing', 'coding', 'workflow', 'browser'] as const;

export type InstructionSetName = (typeof instructionSetNames)[number];

// A profile without `instruction-sets:` loads these. Browser rules are opt-in.
export const defaultInstructionSetNames: InstructionSetName[] = ['writing', 'coding', 'workflow'];

export const isInstructionSetName = (name: string): name is InstructionSetName =>
  instructionSetNames.some((setName) => setName === name);

export const readInstructionSet = async (name: InstructionSetName): Promise<string> => {
  const path = new URL(`../extensions/${name}/instructions.md`, import.meta.url);
  const instructions = await readFile(path, 'utf8');

  const trimmedInstructions = instructions.trim();

  if (!trimmedInstructions) {
    throw new Error(`The ${name} instructions are empty: ${path.href}`);
  }

  return trimmedInstructions;
};
