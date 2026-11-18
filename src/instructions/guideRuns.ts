import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { resolveStommeGuides } from './stommeGuides/stommeGuides.js';
import type { GuideSnapshot } from './stommeGuides/stommeGuides.js';
import type { Guide } from './stommeGuides/stommeGuidesDecision.js';

export interface GuideRuns {
  snapshot: () => Promise<GuideSnapshot>;
}

interface GuideRunOptions {
  // Only a session that loads the coding set shows a notice for broken guides.
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

// A project guide links relative to `docs/stomme/` in the project. A bundled guide links relative to
// the bundle, so its source names the bundle's real folder.
const sourceFolder = (snapshot: UsableSnapshot): string =>
  snapshot.kind === 'project' ? 'docs/stomme' : snapshot.root;

const guideSection = (folder: string, guide: Guide): string =>
  `Source: ${folder}/${guide.path}\n\n${guide.text.trim()}`;

export const codingSetText = (snapshot: GuideSnapshot): string => {
  if (snapshot.kind === 'broken') {
    return `${brokenNotice(oneLine(snapshot.reason))}. Tell the user before you change any code.`;
  }

  const heading = `# Stomme ${snapshot.version} coding guides, ${guideFolder(snapshot)}`;
  const folder = sourceFolder(snapshot);
  const sections = snapshot.guides.map((guide) => guideSection(folder, guide));

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
    snapshot: () => {
      if (run === undefined && sessionDirectory !== undefined) {
        run = resolve(sessionDirectory);
      }

      return run ?? sessionNotStarted();
    },
  };
};
