import { useSyncExternalStore } from 'react';
import { useDataSeed } from '../data/seeds';
import { formatTime as time } from '../data/time.ts';
import { repositoryTime as repository } from './code.ts';
import { pullElapsed as pull } from '../tasks/pull-presentation.ts';
import { seenAgo as seen } from './performance.ts';
import * as requests from './requests.ts';
const subscribe = () => () => {};
/** Freeze clock and timezone through hydration; then resume the browser's local labels. */
export function useProjectFormatting() {
  const seed = useDataSeed();
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const now = !hydrated && seed ? seed.at : Date.now();
  const zone = !hydrated ? seed?.timeZone : undefined;
  return {
    now,
    timeZone: zone,
    localeDate: (
      value: string | number,
      options?: Intl.DateTimeFormatOptions,
      withTime = false,
      preferredLocale?: string,
    ) => {
      const date = new Date(value);
      const locale = preferredLocale ?? (!hydrated && seed ? 'en-US' : undefined);
      const settings = { ...options, ...(zone ? { timeZone: zone } : {}) };
      return withTime
        ? date.toLocaleString(locale, settings)
        : date.toLocaleDateString(locale, settings);
    },
    formatCount: (value: number) => value.toLocaleString(!hydrated && seed ? 'en-US' : undefined),
    formatTime: (
      value: Parameters<typeof time>[0],
      style?: Parameters<typeof time>[1],
      at = new Date(now),
    ) => time(value, style, at, zone),
    repositoryTime: (value?: string) => repository(value, now),
    pullElapsed: (value?: string) => pull(value, now),
    seenAgo: (at: number) => seen(at, now),
    formatWhen: (at: number) => requests.formatWhen(at, now, false, zone),
    peakWhen: (at: number) => requests.peakWhen(at, now, zone),
    formatRowTime: (at: number) => requests.formatRowTime(at, now, zone),
    formatRequestClock: (at: number) => requests.formatRequestClock(at, zone),
    formatRequestTime: (at: number) => requests.formatRequestTime(at, now, zone),
    chartTicks: (from: number, to: number, range: requests.RequestRange) =>
      requests.chartTicks(from, to, range, now, zone),
    chartReadout: (point: requests.RequestSummary['series']['points'][number]) =>
      requests.chartReadout(point, now, zone),
    errorsLine: (summary: requests.RequestSummary) => requests.errorsLine(summary, now, zone),
  };
}
