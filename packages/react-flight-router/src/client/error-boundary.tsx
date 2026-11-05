"use client";

import { Component, cloneElement, isValidElement, type ReactNode, type ErrorInfo } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Fallback to show when an error is caught.
   * - Function: receives the Error and returns ReactNode
   * - ReactElement: cloned with an `error` prop injected
   * - Other ReactNode: rendered as-is
   */
  fallback?: ReactNode | ((error: Error) => ReactNode);
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

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[react-flight-router] ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return fallback(this.state.error);
      }
      if (isValidElement(fallback)) {
        return cloneElement(fallback as any, { error: this.state.error });
      }
      return fallback ?? null;
    }
    return this.props.children;
  }
}
