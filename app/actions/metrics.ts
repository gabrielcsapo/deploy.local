'use server';

import {
  getMetricsHistory,
  getRequestRateBuckets,
  getRequestPunchcard,
} from '../../server/store.ts';
import { getContainerStats } from '../../server/docker.ts';

export async function fetchMetricsHistory(name: string, minutes = 60) {
  const since = Date.now() - minutes * 60_000;
  return getMetricsHistory(name, since);
}

export async function fetchContainerStats(name: string) {
  return getContainerStats(name);
}

export async function fetchRequestRate(name: string, minutes = 60) {
  const since = Date.now() - minutes * 60_000;
  const bucketSizeMs = (minutes * 60_000) / 60;
  return getRequestRateBuckets(name, since, bucketSizeMs);
}

export async function fetchRequestPunchcard(name: string) {
  return getRequestPunchcard(name);
}
