"use client";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { createElement, Fragment, type ReactNode } from "react";
import { RouterProvider, useRouter, type NavigateOptions } from "./router-context.js";
import { ScrollRestoration, STORAGE_KEY, getScrollPositions } from "./scroll-restoration.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStream(payload: object): ReadableStream {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function fakeCreateFromReadableStream(stream: ReadableStream): Promise<any> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder().decode(chunks[0]));
}

const noop = async () => {};

type NavigateFn = (to: string, options?: NavigateOptions) => void;

let navigate: NavigateFn;

function CaptureNavigate() {
  navigate = useRouter().navigate;
  return null;
}

function renderRouter(): void {
  render(
    createElement(RouterProvider, {
      initialUrl: "/models",
      initialSegments: { root: createElement("div", null, "root") },
      initialParams: {},
      createFromReadableStream: fakeCreateFromReadableStream as any,
      callServer: noop as any,
      children: createElement(
        Fragment,
        null,
        createElement(ScrollRestoration),
        createElement(CaptureNavigate),
      ) as ReactNode,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("<ScrollRestoration /> preventScrollReset", () => {
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    history.replaceState(null, "", "/models");

    scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    // The page is scrolled down when the navigation starts — that offset is
    // exactly what these navigations must or must not throw away.
    Object.defineProperty(window, "scrollY", { value: 4200, configurable: true });

    // A fresh stream per call — a shared one is locked after the first read,
    // so the second navigation in a test would fail instead of applying.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        body: makeStream({ segments: { root: createElement("div", null, "next") }, params: {} }),
        status: 200,
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("scrolls to the top on an ordinary navigation", async () => {
    renderRouter();

    await act(async () => {
      await navigate("/models/anvil");
    });

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("leaves the page alone when the navigation opts out", async () => {
    renderRouter();

    await act(async () => {
      await navigate("/models/anvil", { preventScrollReset: true });
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("records the opt-out on the history entry", async () => {
    renderRouter();

    await act(async () => {
      await navigate("/models/anvil", { preventScrollReset: true });
    });

    expect(history.state).toMatchObject({ preventScrollReset: true });
    expect(typeof history.state.key).toBe("string");
  });

  it("does not mark entries from ordinary navigations", async () => {
    renderRouter();

    await act(async () => {
      await navigate("/models/anvil");
    });

    expect(history.state.preventScrollReset).toBeUndefined();
  });

  it("saves the held position for the new entry so back/forward can restore it", async () => {
    renderRouter();

    await act(async () => {
      await navigate("/models/anvil", { preventScrollReset: true });
    });

    // Nothing scrolled, so no scroll event fires to save the position — the
    // opt-out branch has to record it, or returning to this entry finds nothing.
    expect(getScrollPositions()).toEqual({ [history.state.key]: 4200 });
  });

  it("carries the opt-out through a replacing navigation", async () => {
    renderRouter();

    await act(async () => {
      await navigate("/models", { replace: true, preventScrollReset: true });
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(history.state).toMatchObject({ preventScrollReset: true });
  });

  it("still resets on a later ordinary navigation from an opted-out entry", async () => {
    renderRouter();

    await act(async () => {
      await navigate("/models/anvil", { preventScrollReset: true });
    });
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => {
      await navigate("/audio");
    });

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("writes positions under the shared storage key", async () => {
    renderRouter();

    await act(async () => {
      await navigate("/models/anvil", { preventScrollReset: true });
    });

    expect(sessionStorage.getItem(STORAGE_KEY)).toContain("4200");
  });
});
