import type { ThemeColor, ThemeStyle } from '@earendil-works/pi-coding-agent';

import type { PlanStep } from './steps.js';

export interface StepStyle {
  mark: string;
  markColor: ThemeColor;
  textStyle: ThemeStyle;
}

export const stepStyles = {
  pending: { mark: '\u{F10C}', markColor: 'muted', textStyle: { fg: 'muted' } },
  in_progress: { mark: '\u{F192}', markColor: 'accent', textStyle: { bold: true } },
  completed: {
    mark: '\u{F058}',
    markColor: 'success',
    textStyle: { fg: 'dim', strikethrough: true },
  },
  blocked: { mark: '\u{F06A}', markColor: 'warning', textStyle: { fg: 'warning' } },
} as const satisfies Record<PlanStep['status'], StepStyle>;

export const stepStyle = (status: PlanStep['status']): StepStyle => stepStyles[status];
