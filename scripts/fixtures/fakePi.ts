#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface Script {
  onPrompt: string[];
  onDialogResponse: string[];
  exitCode?: number;
}

const script = JSON.parse(readFileSync('fake-pi.json', 'utf8')) as Script;
const settingsPath = '.pi/settings.json';
const settings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;
const records: unknown[] = [];

const emit = (lines: string[]) => {
  process.stdout.write(lines.map((line) => `${line}\n`).join(''));
};

const save = () => {
  const got = { cwd: process.cwd(), arguments: process.argv.slice(2), settings, records };

  writeFileSync('fake-pi-got.json', JSON.stringify(got));
};

const receive = (line: string) => {
  const record = JSON.parse(line) as { type?: string };

  records.push(record);
  save();

  if (record.type === 'extension_ui_response') {
    emit(script.onDialogResponse);

    return;
  }

  emit(script.onPrompt);

  if (script.exitCode !== undefined) {
    process.exit(script.exitCode);
  }
};

let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk: string) => {
  buffer += chunk;

  const lines = buffer.split('\n');

  buffer = lines.pop() ?? '';
  lines.forEach(receive);
});

// Stay alive after stdin closes, as a Pi that waits for a worker does.
setInterval(() => undefined, 60_000);
