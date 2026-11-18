import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { resolveStommeGuides } from './stommeGuides/stommeGuides.js';
import type { GuideSnapshot } from './stommeGuides/stommeGuides.js';
import type { Guide } from './stommeGuides/stommeGuidesDecision.js';

export interface GuideRuns {
  snapshot: () => Promise<GuideSnapshot>;
  // Reads the guides now and leaves the run's snapshot as it is.
  current: () => Promise<GuideSnapshot>;
  usesCodingSet: () => Promise<boolean>;
}

interface GuideRunOptions {
  usesCodingSet?: () => Promise<boolean>;
  resolve?: typeof resolveStommeGuides;
}

type UsableSnapshot = Exclude<GuideSnapshot, { kind: 'broken' }>;

const brokenNotice = (reason: string): string =>
  `Tau could not load the stomme coding guides: ${reason}`;

const oneLine = (text: string): string => text.replaceAll(/\s*[\r\n]\s*/g, ' ');

const guideFolder = (snapshot: UsableSnapshot): string =>
  snapshot.kind === 'project'
    ? `from ${join(snapshot.root, 'docs', 'stomme')}/`
    : 'bundled with Tau';

const sourceFolder = (snapshot: UsableSnapshot): string =>
  snapshot.kind === 'project' ? 'docs/stomme' : snapshot.root;

export const guideSection = (snapshot: UsableSnapshot, guide: Guide): string =>
  `Source: ${sourceFolder(snapshot)}/${guide.path}\n\n${guide.text.trim()}`;

export const codingSetText = (snapshot: GuideSnapshot): string => {
  if (snapshot.kind === 'broken') {
    return `${brokenNotice(oneLine(snapshot.reason))}. Tell the user before you change any code.`;
  }

  const heading = `# Stomme ${snapshot.version} coding guides, ${guideFolder(snapshot)}`;
  const sections = snapshot.guides.map((guide) => guideSection(snapshot, guide));

  return [heading, ...sections].join('\n\n');
};

const sessionNotStarted = (): Promise<GuideSnapshot> =>
  Promise.reject(new Error('Tau read the stomme guides before the Pi session started.'));

// Each Pi run reads the guides once, so a run never mixes two versions between model calls.
export const trackGuideRuns = (
  pi: Pick<ExtensionAPI, 'on'>,
  options: GuideRunOptions = {},
): GuideRuns => {
  const { usesCodingSet = () => Promise.resolve(true), resolve = resolveStommeGuides } = options;
  let sessionDirectory: string | undefined;
  let run: Promise<GuideSnapshot> | undefined;
  let lastReason: string | undefined;

  const notifyBroken = async (reason: string, context: ExtensionContext): Promise<void> => {
    if (reason === lastReason || !(await usesCodingSet())) {
      return;
    }

    lastReason = reason;
    context.ui.notify(brokenNotice(reason), 'error');
  };

  pi.on('session_start', (_event, context) => {
    sessionDirectory = context.cwd;
  });

  pi.on('before_agent_start', async (_event, context) => {
    run = resolve(context.cwd);

    const snapshot = await run;

    if (snapshot.kind === 'broken') {
      await notifyBroken(snapshot.reason, context);
    } else {
      lastReason = undefined;
    }
  });

  return {
    usesCodingSet,
    current: () =>
      sessionDirectory === undefined ? sessionNotStarted() : resolve(sessionDirectory),
    snapshot: () => {
      if (run === undefined && sessionDirectory !== undefined) {
        run = resolve(sessionDirectory);
      }

      return run ?? sessionNotStarted();
    },
  };
};
