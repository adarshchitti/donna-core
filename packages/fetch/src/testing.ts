/**
 * Test helpers, exported because every package that fetches needs them.
 *
 * The HTTP layer is INJECTED rather than monkey-patched onto `globalThis`:
 * a patched global leaks across test files and can silently let a real
 * request out. A stub passed in as an argument cannot.
 */

import type { FetchLike, HttpRequestInit, HttpResponse } from './types.js';

export interface StubCall {
  url: string;
  init: HttpRequestInit;
}

/** A canned HTTP reply, or an Error to throw (a network failure). */
export type StubReply = { status: number; body: string } | Error;

export interface StubFetch {
  impl: FetchLike;
  calls: StubCall[];
}

/**
 * A fetch stub that answers from `replies` in order, repeating the last one
 * once exhausted, and records every call it received.
 */
export const stubFetch = (replies: StubReply[]): StubFetch => {
  const calls: StubCall[] = [];
  let next = 0;
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const reply = replies[Math.min(next, replies.length - 1)];
    next += 1;
    if (reply === undefined) throw new Error('stubFetch was given no replies');
    if (reply instanceof Error) throw reply;
    const res: HttpResponse = {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      text: async () => reply.body,
    };
    return res;
  };
  return { impl, calls };
};

/**
 * A fetch stub that fails the test if it is called at all -- the proof that a
 * replay-mode run cannot reach the network.
 */
export const forbiddenFetch = (): StubFetch => {
  const calls: StubCall[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    throw new Error(`Network call attempted in an offline test: ${url}`);
  };
  return { impl, calls };
};
