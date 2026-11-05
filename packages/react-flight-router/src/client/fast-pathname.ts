"use client";

/**
 * Extract the pathname portion of a URL string, fast-pathing the common
 * shape used by Link/useLocation/etc.: a relative URL starting with "/"
 * and not protocol-relative.
 *
 * Real apps run this on every render of every Link, plus once per
 * navigation in useLocation, useParams, etc. Constructing a WHATWG URL
 * just to read .pathname is heavyweight for a value that, in 95%+ of
 * cases, can be sliced out of the input directly.
 *
 * Falls back to `new URL(input, origin).pathname` for absolute URLs and
 * protocol-relative URLs ("//host/path"), where naive slicing would
 * mis-identify the host as part of the path.
 */
export function fastPathname(input: string, origin: string): string {
  if (input.length > 0 && input.charCodeAt(0) === 47 /* "/" */) {
    // Protocol-relative URLs like "//example.com/foo" have no scheme but
    // their pathname is everything after the host — only WHATWG can split
    // them correctly.
    if (input.length > 1 && input.charCodeAt(1) === 47) {
      return new URL(input, origin).pathname;
    }
    // Strip query (`?`) or fragment (`#`), whichever comes first.
    for (let i = 1; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c === 63 /* "?" */ || c === 35 /* "#" */) return input.slice(0, i);
    }
    return input;
  }
  return new URL(input, origin).pathname;
}
