import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';

export const confirmContext = (
  cwd: string,
  confirm: (title: string, message: string) => Promise<boolean>,
): ExtensionToolContext =>
  ({
    cwd,
    hasUI: true,
    ui: { confirm },
  }) as unknown as ExtensionToolContext;

export const noUiContext = (cwd: string): ExtensionToolContext =>
  ({
    cwd,
    hasUI: false,
    ui: {},
  }) as unknown as ExtensionToolContext;
