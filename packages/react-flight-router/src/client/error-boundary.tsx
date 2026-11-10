'use client';

import { Component, cloneElement, isValidElement, type ReactNode, type ErrorInfo } from 'react';
import { recoverFromChunkError } from './build-check.js';

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Fallback to show when an error is caught.
   * - Function: receives the Error and a `reset` that renders the children again
   * - ReactElement: cloned with `error` and `reset` props injected
   * - Other ReactNode: rendered as-is
   */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches rendering errors in child components.
 * Works with both server-originated errors and client-side rendering errors.
 *
 * Place around <Outlet /> in your layout:
 *
 *   <ErrorBoundary fallback={(error) => <p>{error.message}</p>}>
 *     <Outlet />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  /** Clears the caught error so the children render again. */
  reset = () => {
    this.setState({ error: null });
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[react-flight-router] ErrorBoundary caught:', error, errorInfo);
    void recoverFromChunkError(error);
  }

  render() {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback(this.state.error, this.reset);
      }
      if (isValidElement(fallback)) {
        return cloneElement(fallback as any, { error: this.state.error, reset: this.reset });
      }
      return fallback ?? null;
    }
    return this.props.children;
  }
}
