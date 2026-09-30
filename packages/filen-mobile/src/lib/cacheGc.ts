// GC tuning shared by the disk caches (fileCache, audioCache, rawPreviewCache).

export const GC_AGE_MS = 24 * 60 * 60 * 1000
export const GC_DEBOUNCE_MS = 30 * 1000
// Bounds gc fan-out so a large cache doesn't launch O(N) concurrent native FS ops + JSON parses on the
// single Hermes JS thread, worst during the synchronous app-background sweep. The per-key mutexes are
// for correctness, not throttling, so a separate cap is needed.
export const GC_CONCURRENCY = 8
