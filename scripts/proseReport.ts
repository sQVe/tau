import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isMissingFile } from '../src/errors.ts';
import { copyKey, scanTranscriptLines } from '../src/improvement/transcript.ts';
import type { Entry } from '../src/improvement/transcript.ts';
import { isRecord } from '../src/schema.ts';
import { formatProseSummary, summarizeProse } from './proseReport/proseReportSummary.ts';
import type { ProseReply, ProseText } from './proseReport/proseReportSummary.ts';
import { readInTurn } from './readInTurn.ts';

export interface ProseReportOptions {
  sessions: string;
  project: string;
  files: number;
  replies: number;
  sample: number;
  texts: string[];
}

interface ReplyCandidate extends ProseReply {
  path: string;
  timestamp: number | undefined;
  copyId: string | undefined;
}

interface DiscoveredFile {
  path: string;
  mtimeMs: number | undefined;
}

const usage = `Usage: node scripts/proseReport.ts [options]

  --sessions <dir>  Session root, default ~/.pi/agent/sessions
  --project <text>  Part of the session directory names, default code-personal-tau
  --files <n>       Newest session files to read, default 200
  --replies <n>     Newest assistant replies to check, default 1200
  --sample <n>      Findings and sentences sampled per rule, default 20
  --text <path>     Whole file to check as one text; repeatable`;

const positiveInteger = (name: string, value: string): number => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, not "${value}".\n\n${usage}`);
  }

  return parsed;
};

const parseArguments = (argv: string[]) => {
  try {
    return parseArgs({
      args: argv,
      options: {
        sessions: { type: 'string', default: resolve(homedir(), '.pi', 'agent', 'sessions') },
        project: { type: 'string', default: 'code-personal-tau' },
        files: { type: 'string', default: '200' },
        replies: { type: 'string', default: '1200' },
        sample: { type: 'string', default: '20' },
        text: { type: 'string', multiple: true },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`${message}\n\n${usage}`, { cause: error });
  }
};

export const parseProseReportArguments = (argv: string[]): ProseReportOptions => {
  const { values } = parseArguments(argv);

  return {
    sessions: values.sessions,
    project: values.project,
    files: positiveInteger('--files', values.files),
    replies: positiveInteger('--replies', values.replies),
    sample: positiveInteger('--sample', values.sample),
    texts: values.text ?? [],
  };
};

const sessionRoots = async (sessions: string, project: string): Promise<string[]> => {
  let entries: Dirent[];

  try {
    entries = await readdir(sessions, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`Session directory not found: ${sessions}`, { cause: error });
    }

    const code = isRecord(error) && typeof error.code === 'string' ? error.code : String(error);

    throw new Error(`Cannot read session directory ${sessions}: ${code}`, { cause: error });
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.includes(project))
    .map((entry) => join(sessions, entry.name));
};

const isJsonlFile = (entry: Dirent) => entry.isFile() && entry.name.endsWith('.jsonl');

const listingOf = async (root: string, warn: (message: string) => void): Promise<Dirent[]> => {
  try {
    return await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    warn(`Skipped unreadable directory ${root}`);

    return [];
  }
};

const jsonlFiles = async (roots: string[], warn: (message: string) => void): Promise<string[]> => {
  const listings = await readInTurn(roots, (root) => listingOf(root, warn));

  return listings.flatMap((entries) =>
    entries.flatMap((entry) => (isJsonlFile(entry) ? [join(entry.parentPath, entry.name)] : [])),
  );
};

const modificationTime = async (path: string): Promise<DiscoveredFile> => {
  try {
    const { mtimeMs } = await stat(path);

    return { path, mtimeMs };
  } catch {
    return { path, mtimeMs: undefined };
  }
};

const newestFiles = async (paths: string[], limit: number, warn: (message: string) => void) => {
  const discovered = await readInTurn(paths, modificationTime);
  const readable: { path: string; mtimeMs: number }[] = [];
  let unreadable = 0;

  for (const file of discovered) {
    if (file.mtimeMs === undefined) {
      unreadable += 1;
      warn(`Skipped unreadable file ${file.path}`);
    } else {
      readable.push({ path: file.path, mtimeMs: file.mtimeMs });
    }
  }

  const files = readable
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((file) => file.path);

  return { files, unreadable };
};

const contentTexts = (content: unknown): string[] => {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) =>
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  );
};

const replyOf = (
  entry: Entry,
): { text: string; model: string; timestamp: number | undefined } | undefined => {
  if (entry.type !== 'message' || !isRecord(entry.message)) {
    return undefined;
  }

  const { message } = entry;

  if (message.role !== 'assistant') {
    return undefined;
  }

  const texts = contentTexts(message.content);

  if (texts.length === 0) {
    return undefined;
  }

  const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;

  return {
    text: texts.join('\n\n'),
    model: typeof message.model === 'string' ? message.model : 'unknown',
    timestamp: Number.isNaN(time) ? undefined : time,
  };
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

const completeCopyId = (entry: Entry): string | undefined => {
  const { id, timestamp } = entry;

  if (!nonEmptyString(id) || !nonEmptyString(timestamp)) {
    return undefined;
  }

  return copyKey(entry);
};

const parseReplies = (
  path: string,
  text: string,
  warn: (message: string) => void,
): { replies: ReplyCandidate[]; malformed: number } => {
  const replies: ReplyCandidate[] = [];
  let malformed = 0;

  for (const line of scanTranscriptLines(text)) {
    if (line.status === 'malformed') {
      malformed += 1;
      warn(`Skipped malformed line ${path}:${line.line}`);

      continue;
    }

    if (line.status === 'notARecord') {
      continue;
    }

    const reply = replyOf(line.entry);

    if (reply !== undefined) {
      replies.push({
        ...reply,
        path,
        source: basename(path),
        line: line.line,
        copyId: completeCopyId(line.entry),
      });
    }
  }

  return { replies, malformed };
};

const byRecency = (left: ReplyCandidate, right: ReplyCandidate): number => {
  const leftTime = left.timestamp ?? Number.NEGATIVE_INFINITY;
  const rightTime = right.timestamp ?? Number.NEGATIVE_INFINITY;

  return rightTime - leftTime || left.path.localeCompare(right.path) || left.line - right.line;
};

const representatives = (replies: ReplyCandidate[]): ReplyCandidate[] => {
  const winners = new Map<string, ReplyCandidate>();

  for (const reply of replies) {
    if (reply.copyId === undefined) {
      continue;
    }

    const current = winners.get(reply.copyId);

    if (current === undefined || byRecency(reply, current) < 0) {
      winners.set(reply.copyId, reply);
    }
  }

  return replies.filter(
    (reply) => reply.copyId === undefined || winners.get(reply.copyId) === reply,
  );
};

const readReplies = async (
  path: string,
  warn: (message: string) => void,
): Promise<{ replies: ReplyCandidate[]; malformed: number; unreadable: number }> => {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch {
    warn(`Skipped unreadable file ${path}`);

    return { replies: [], malformed: 0, unreadable: 1 };
  }

  return { ...parseReplies(path, text, warn), unreadable: 0 };
};

const collectReplies = async (
  options: ProseReportOptions,
  warn: (message: string) => void,
): Promise<{ replies: ProseReply[]; skippedFiles: number; skippedLines: number }> => {
  const roots = await sessionRoots(options.sessions, options.project);
  const discovered = await jsonlFiles(roots, warn);
  const newest = await newestFiles(discovered, options.files, warn);
  const parsed = await readInTurn(newest.files, (path) => readReplies(path, warn));
  const replies = representatives(parsed.flatMap((result) => result.replies));

  const skippedFiles =
    newest.unreadable + parsed.reduce((total, result) => total + result.unreadable, 0);

  const skippedLines = parsed.reduce((total, result) => total + result.malformed, 0);

  const newestReplies = replies
    .toSorted(byRecency)
    .slice(0, options.replies)
    .map((reply) => ({
      source: reply.source,
      line: reply.line,
      model: reply.model,
      text: reply.text,
    }));

  return { replies: newestReplies, skippedFiles, skippedLines };
};

const readTextFile = async (path: string): Promise<ProseText> => {
  try {
    return { name: basename(path), text: await readFile(path, 'utf8') };
  } catch {
    throw new Error(`Cannot read text file: ${path}`);
  }
};

const warn = (message: string) => process.stderr.write(`${message}\n`);

const main = async () => {
  const options = parseProseReportArguments(process.argv.slice(2));
  const { replies, skippedFiles, skippedLines } = await collectReplies(options, warn);
  const texts = await readInTurn(options.texts, readTextFile);
  const summary = summarizeProse(replies, texts, options.sample, skippedFiles, skippedLines);

  process.stdout.write(formatProseSummary(summary));
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
