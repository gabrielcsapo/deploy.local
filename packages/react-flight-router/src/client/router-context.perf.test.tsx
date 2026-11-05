"use client";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { Profiler, StrictMode, createElement, useMemo, useState, type ReactNode } from "react";
import { Link } from "./link.js";
import { Outlet } from "./outlet.js";
import { _testInternals, useRouter } from "./router-context.js";

const { NavigationActionsContext, LocationContext, SegmentsContext } = _testInternals;

const NUM_LINKS = 50;
const NOOP_NAVIGATE = () => {};
const NOOP_REFRESH = async () => {};

interface Counters {
  links: number;
  outlet: number;
}

/**
 * Stateful container that owns the segments/location triggers and exposes
 * test buttons for bumping each. State lives here so children passed via
 * `children` are reconciled as stable element references — meaning React
 * doesn't re-render them just because this component's state changed.
 * The only re-renders are driven by context subscription.
 */
function ProviderShell({ children }: { children: ReactNode }) {
  const [segmentsTrigger, setSegmentsTrigger] = useState(0);
  const [locationTrigger, setLocationTrigger] = useState(0);

  const actionsValue = useMemo(() => ({ navigate: NOOP_NAVIGATE, refresh: NOOP_REFRESH }), []);

  const locationValue = useMemo(
    () => ({
      url: `/page-${locationTrigger}`,
      pendingUrl: null,
      navigationState: "idle" as const,
    }),
    [locationTrigger],
  );

  const segmentsValue = useMemo(
    () => ({
      segments: {
        root: createElement("div", { key: segmentsTrigger }, `segment-${segmentsTrigger}`),
      },
      params: {},
      boundaryComponents: {},
      navigationError: null,
      childKeyByParent: { "": "root" },
    }),
    [segmentsTrigger],
  );

  return (
    <NavigationActionsContext.Provider value={actionsValue}>
      <LocationContext.Provider value={locationValue}>
        <SegmentsContext.Provider value={segmentsValue}>
          <button data-testid="bump-segments" onClick={() => setSegmentsTrigger((n) => n + 1)}>
            bump segments
          </button>
          <button data-testid="bump-location" onClick={() => setLocationTrigger((n) => n + 1)}>
            bump location
          </button>
          {children}
        </SegmentsContext.Provider>
      </LocationContext.Provider>
    </NavigationActionsContext.Provider>
  );
}

/**
 * Subtree that consumes the contexts. Computed once at mount and passed as
 * stable children to ProviderShell so React doesn't re-render it just
 * because ProviderShell's state changed — only context-subscription work
 * causes re-renders below this point.
 */
function makeConsumers(counters: Counters): ReactNode {
  return (
    <>
      {Array.from({ length: NUM_LINKS }, (_, i) => (
        <Profiler
          key={i}
          id={`link-${i}`}
          onRender={() => {
            counters.links++;
          }}
        >
          <Link to={`/route-${i}`}>{`Link ${i}`}</Link>
        </Profiler>
      ))}
      <Profiler
        id="outlet"
        onRender={() => {
          counters.outlet++;
        }}
      >
        <Outlet />
      </Profiler>
    </>
  );
}

describe("RouterContext split — render isolation", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { origin: "http://localhost", pathname: "/", search: "" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Link components do NOT re-render when only SegmentsContext changes", () => {
    const counters: Counters = { links: 0, outlet: 0 };
    const { getByTestId } = render(<ProviderShell>{makeConsumers(counters)}</ProviderShell>);

    expect(counters.links).toBe(NUM_LINKS); // each Link rendered exactly once on mount

    const initialLinkRenders = counters.links;
    const initialOutletRenders = counters.outlet;

    act(() => {
      fireEvent.click(getByTestId("bump-segments"));
    });

    // Outlet (subscribes to SegmentsContext) re-rendered.
    expect(counters.outlet).toBeGreaterThan(initialOutletRenders);

    // Links (subscribe only to NavigationActions + Location) did NOT re-render.
    expect(counters.links - initialLinkRenders).toBe(0);
  });

  it("Link components DO re-render when LocationContext changes", () => {
    const counters: Counters = { links: 0, outlet: 0 };
    const { getByTestId } = render(<ProviderShell>{makeConsumers(counters)}</ProviderShell>);

    const initialLinkRenders = counters.links;

    act(() => {
      fireEvent.click(getByTestId("bump-location"));
    });

    // Each Link re-rendered exactly once for the location change.
    expect(counters.links - initialLinkRenders).toBe(NUM_LINKS);
  });

  it("A/B vs useRouter-based Link: split eliminates Link re-renders on segment changes", () => {
    // A "legacy" Link that subscribes to the merged useRouter() value the
    // way pre-split components did. Same shape, different hook — re-renders
    // whenever ANY router slice changes.
    function LegacyLink({ to }: { to: string }) {
      const router = useRouter();
      return createElement("a", { href: to }, `${to} (${router?.url ?? ""})`);
    }

    function makeBoth(counters: { split: number; legacy: number }): ReactNode {
      return (
        <>
          {Array.from({ length: NUM_LINKS }, (_, i) => (
            <Profiler
              key={`split-${i}`}
              id={`split-${i}`}
              onRender={() => {
                counters.split++;
              }}
            >
              <Link to={`/route-${i}`}>{`Link ${i}`}</Link>
            </Profiler>
          ))}
          {Array.from({ length: NUM_LINKS }, (_, i) => (
            <Profiler
              key={`legacy-${i}`}
              id={`legacy-${i}`}
              onRender={() => {
                counters.legacy++;
              }}
            >
              <LegacyLink to={`/route-${i}`} />
            </Profiler>
          ))}
        </>
      );
    }

    const counters = { split: 0, legacy: 0 };
    const { getByTestId } = render(<ProviderShell>{makeBoth(counters)}</ProviderShell>);

    // Both groups mount once each
    expect(counters.split).toBe(NUM_LINKS);
    expect(counters.legacy).toBe(NUM_LINKS);

    const splitBefore = counters.split;
    const legacyBefore = counters.legacy;

    act(() => {
      fireEvent.click(getByTestId("bump-segments"));
    });

    const splitDelta = counters.split - splitBefore;
    const legacyDelta = counters.legacy - legacyBefore;

    // eslint-disable-next-line no-console
    console.log(
      `segments-only update, ${NUM_LINKS} links/group:  ` +
        `split (narrow hooks)=${splitDelta} renders   legacy (useRouter)=${legacyDelta} renders`,
    );

    expect(splitDelta).toBe(0);
    expect(legacyDelta).toBe(NUM_LINKS);
  });

  it("under StrictMode, segment-only updates still skip Links", () => {
    // StrictMode double-invokes render functions; the relative comparison
    // (delta of 0 from the post-mount baseline) still holds because the
    // doubling is symmetric.
    const counters: Counters = { links: 0, outlet: 0 };
    const { getByTestId } = render(
      <StrictMode>
        <ProviderShell>{makeConsumers(counters)}</ProviderShell>
      </StrictMode>,
    );

    const initialLinkRenders = counters.links;
    act(() => {
      fireEvent.click(getByTestId("bump-segments"));
    });

    expect(counters.links - initialLinkRenders).toBe(0);
  });
});
