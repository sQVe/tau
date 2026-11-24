import type { ChildProcess } from 'node:child_process';

export const probeTimeoutMilliseconds = 10_000;

const processIdPattern = /^[1-9][0-9]*$/;

export const parseProcessId = (text: string): number => {
  const [line = ''] = text.split('\n');

  if (!processIdPattern.test(line)) {
    throw new Error(`A process ID is plain decimal digits, not ${JSON.stringify(line)}.`);
  }

  return Number(line);
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
      child.off('close', listeners.close);
      child.stdout?.off('data', listeners.data);

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

    const listeners = {
      // 'close' fires after the child's stdio is drained, so a parent that prints its ID and
      // exits at once is still read.
      close: (): void => {
        finish(new Error('The parent exited before it printed its holder process ID.'));
      },
      data: (chunk: Buffer): void => {
        text += chunk.toString('utf8');

        if (text.includes('\n')) {
          finish();
        }
      },
      error: (error: Error): void => {
        finish(error);
      },
      timeout: (): void => {
        finish(
          new Error(
            `The parent did not print its holder process ID within ${String(probeTimeoutMilliseconds)} ms.`,
          ),
        );
      },
    };

    const timer = setTimeout(listeners.timeout, probeTimeoutMilliseconds);

    // A child that emits 'error' with no listener throws, so this one stays after settlement and
    // absorbs a late failure.
    child.on('error', listeners.error);
    child.once('close', listeners.close);
    child.stdout?.on('data', listeners.data);
  });
