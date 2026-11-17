import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { readEvents, writeEvent } from '../../improvement/event.js';
import { findOptionalProjectRoot, projectRootsOf } from '../../improvement/projectRoot.js';
import { readSweepIndex } from '../../improvement/sweepIndex.js';
import { evidenceOf, eventId, sessionFacts } from './recordAction.js';
import type { SessionFacts } from './recordAction.js';

interface PassFailure {
  projectRoot: string;
  reason: string;
}

export interface PassResult {
  id: string;
  paths: string[];
  failed: PassFailure[];
}

const passCandidates = async (agentDirectory: string, cwd: string): Promise<string[]> => {
  const index = await readSweepIndex(agentDirectory);
  const indexed = index.status === 'read' ? Object.keys(index.index.projects) : [];
  const roots = projectRootsOf(indexed, await findOptionalProjectRoot(cwd));

  if (roots.length === 0) {
    throw new Error(`No project root to record the pass in from ${cwd}.`);
  }

  return roots;
};

const readRoots = async (candidates: string[], failed: PassFailure[]): Promise<string[]> => {
  const roots: string[] = [];

  for (const projectRoot of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- A failed root must not stop the other roots.
      const { events } = await readEvents(projectRoot);

      if (events.length > 0) {
        roots.push(projectRoot);
      }
    } catch (error) {
      failed.push({ projectRoot, reason: errorMessage(error) });
    }
  }

  return roots;
};

export const recordPass = async (
  agentDirectory: string,
  facts: SessionFacts,
): Promise<PassResult> => {
  const id = eventId('pass', facts.sessionId, facts.toolCallId);
  const paths: string[] = [];
  const failed: PassFailure[] = [];
  const roots = await readRoots(await passCandidates(agentDirectory, facts.cwd), failed);

  for (const projectRoot of roots) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- A failed root must not stop the other roots.
      const { path, outcome } = await writeEvent(projectRoot, {
        version: 2,
        id,
        kind: 'pass',
        createdAt: facts.createdAt,
        evidence: [evidenceOf(facts)],
        pass: 'correct',
      });

      if (outcome === 'saved') {
        paths.push(path);
      }
    } catch (error) {
      failed.push({ projectRoot, reason: errorMessage(error) });
    }
  }

  return { id, paths, failed };
};

export const runPass = async (
  toolCallId: string,
  context: ExtensionContext,
  agentDirectory: string,
): Promise<PassResult> => recordPass(agentDirectory, sessionFacts(toolCallId, context));
