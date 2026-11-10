import type { Vitest } from 'vitest/node';
import type { Reporter } from 'vitest/reporters';

import { selectExactFiles } from './vitestSelection.ts';

export default class ExactFileReporter implements Reporter {
  private readonly allowedFiles: ReadonlySet<string>;

  constructor({ files }: { files: string[] }) {
    this.allowedFiles = new Set(files);
  }

  onInit(context: Vitest): void {
    for (const project of context.projects) {
      const discoverFiles = project.globTestFiles.bind(project);

      project.globTestFiles = async (filters) => {
        const { testFiles, typecheckTestFiles } = await discoverFiles(filters);

        return {
          testFiles: selectExactFiles(testFiles, this.allowedFiles),
          typecheckTestFiles: selectExactFiles(typecheckTestFiles, this.allowedFiles),
        };
      };
    }
  }
}
