'use client';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { ErrorBoundary } from './error-boundary.js';

let broken = true;
function Flaky() {
  if (broken) throw new Error('Unauthorized');
  return createElement('p', null, 'content');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  broken = true;
});

describe('ErrorBoundary reset', () => {
  it('hands a function fallback a reset that renders the children again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let reset: (() => void) | undefined;
    render(
      createElement(ErrorBoundary, {
        fallback: (error: Error, retry: () => void) => {
          reset = retry;
          return createElement('p', null, `failed: ${error.message}`);
        },
        children: createElement(Flaky),
      }),
    );
    expect(screen.getByText('failed: Unauthorized')).toBeTruthy();
    broken = false;
    act(() => reset!());
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('injects reset into an element fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let reset: (() => void) | undefined;
    function Fallback(props: { error?: Error; reset?: () => void }) {
      reset = props.reset;
      return createElement('p', null, `fallback: ${props.error?.message}`);
    }
    render(
      createElement(ErrorBoundary, {
        fallback: createElement(Fallback),
        children: createElement(Flaky),
      }),
    );
    expect(screen.getByText('fallback: Unauthorized')).toBeTruthy();
    broken = false;
    act(() => reset!());
    expect(screen.getByText('content')).toBeTruthy();
  });
});
