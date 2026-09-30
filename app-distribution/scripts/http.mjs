// Every network call the kit makes goes through this so a stalled connection fails the step
// instead of holding the runner until the job is cancelled by hand.
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export function timedFetch(url, options = {}, { fetchImpl = fetch, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  return fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
}
