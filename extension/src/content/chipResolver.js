// Batch resolver for thread-row chip lookups.
//
// Gmail's inbox typically shows ~25-50 thread rows. InboxSDK fires our
// handler once per row, so naive "one fetch per row" would hammer the
// server with 50 parallel requests on every inbox render. This resolver
// collects requests in a short debounce window and issues a single
// /api/crm/threads/by-thread-ids?ids=... batch call, then distributes the
// results to all callers.
//
// Cache: per-threadId results are memoised for `cacheTtlMs`. After a
// mutation (attach/detach via the sidebar), call `invalidate(threadId)` so
// the chip refreshes on next scroll without a full page reload.

import { api } from '../lib/api.js';

export function createChipResolver({ debounceMs = 150, maxBatch = 50, cacheTtlMs = 60_000 } = {}) {
  const cache = new Map();        // threadId -> { result, fetchedAt }
  const pending = new Map();      // threadId -> [resolve fn, ...]
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    if (pending.size >= maxBatch) {
      flush();
    } else {
      flushTimer = setTimeout(flush, debounceMs);
    }
  }

  async function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const batchPending = pending;
    if (!batchPending.size) return;
    // Swap to a fresh map for the next batch BEFORE awaiting so requests
    // arriving while we're in flight queue up cleanly.
    const batch = Array.from(batchPending.keys());
    pending.clear();
    try {
      const url = '/api/crm/threads/by-thread-ids?ids=' + batch.map(encodeURIComponent).join(',');
      const result = await api.get(url) || {};
      const now = Date.now();
      for (const id of batch) {
        const deals = Array.isArray(result[id]) ? result[id] : [];
        cache.set(id, { result: deals, fetchedAt: now });
        for (const cb of (batchPending.get(id) || [])) cb(deals);
      }
    } catch (err) {
      console.warn('[Squideo] chip resolver flush failed', err);
      // Resolve with empty arrays so consumers fall through gracefully.
      for (const [, cbs] of batchPending) {
        for (const cb of cbs) cb([]);
      }
    }
  }

  return {
    resolve(threadId) {
      const cached = cache.get(threadId);
      if (cached && (Date.now() - cached.fetchedAt) < cacheTtlMs) {
        return Promise.resolve(cached.result);
      }
      return new Promise((resolve) => {
        const arr = pending.get(threadId) || [];
        arr.push(resolve);
        pending.set(threadId, arr);
        scheduleFlush();
      });
    },
    invalidate(threadId) {
      cache.delete(threadId);
    },
  };
}

// Module-level singleton so the threadRow handler and any future
// invalidator share the same cache + batch queue.
export const chipResolver = createChipResolver();
