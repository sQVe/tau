import type { ChildProcess } from 'node:child_process';

const probeTimeoutMilliseconds = 10_000;

const parseProcessId = (text: string): number => {
  const newline = text.indexOf('\n');
  const line = newline === -1 ? text : text.slice(0, newline);
  const value = Number(line);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`The parent printed no usable process ID: ${JSON.stringify(text)}.`);
  }

  return value;
};

export const readProcessId = (child: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    let text = '';
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error !== undefined) {
        reject(error);

        return;
      }

      try {
        resolve(parseProcessId(text));
      } catch (parseError) {
        const failure = parseError instanceof Error ? parseError : new Error(String(parseError));

        reject(failure);
      }
    };

    const timer = setTimeout(() => {
      const timeoutError = new Error(
        `The parent did not print its holder process ID within ${String(probeTimeoutMilliseconds)} ms.`,
      );

      finish(timeoutError);
    }, probeTimeoutMilliseconds);

    child.once('error', (error) => {
      finish(error);
    });

    child.once('exit', () => {
      finish(new Error('The parent exited before it printed its holder process ID.'));
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');

      if (text.includes('\n')) {
        finish();
      }
    });
  });
