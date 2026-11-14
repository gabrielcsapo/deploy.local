// Stand-in for react-flight-router/client: the page is mounted directly, and links reload.
import type { ReactNode } from 'react';
export * from '../board-parity/fixture-router.tsx';
export const clearPrefetchCache = () => {};
export const prefetchRSC = () => {};
export const useNavigation = () => ({ state: 'idle' as const });
export const useParams = () => ({});
export const ScrollRestoration = () => null;
export const ErrorBoundary = ({ children }: { children: ReactNode }) => children;
