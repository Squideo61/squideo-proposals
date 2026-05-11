// Batch resolver for thread-row chip lookups.
//
// Gmail's inbox typically shows ~25-50 thread rows. InboxSDK fires our
// handler once per row, so naive "one fetch per row" would hammer the
// server with 50 parallel requests on every inbox render. This resolver
// collects requests in a short debounce window and issues a single
// POST /api/crm/threads/resolve batch call, then distributes the results
// to all callers.
//
// Each call passes both the gmail thread id AND the row's sender emails.
// The server tries explicit links first; if none, falls back to "is this
// sender on a contact attached to a deal?" — so every inbox row from a
// known contact gets a chip, not just ones that were already attached.
//
// Cache: per-threadId results are memoised for `cacheTtlMs`. After a
// mutation (attach/detach via the sidebar), call `invalidate(threadId)` so
// the chip refreshes on next scroll without a full page reload.

import { api } from '../lib/api.js';

export function createChipResolver({ debounceMs = 150, maxBatch = 50, cacheTtlMs = 60_000 } = {}) {
  const cache = new Map();        // threadId -> { result, fetchedAt }
  const pending = new Map();      // threadId -> { senderEmails: Set, callbacks: [fn] }
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
    const items = Array.from(batchPending, ([threadId, entry]) => ({
      threadId,
      senderEmails: Array.from(entry.senderEmails),
    }));
    const callbacksByThread = new Map(
      Array.from(batchPending, ([id, entry]) => [id, entry.callbacks])
    );
    pending.clear();
    try {
      const result = await api.post('/api/crm/threads/resolve', { items }) || {};
      const now = Date.now();
      for (const { threadId } of items) {
        const deals = Array.isArray(result[threadId]) ? result[threadId] : [];
        cache.set(threadId, { result: deals, fetchedAt: now });
        for (const cb of (callbacksByThread.get(threadId) || [])) cb(deals);
      }
    } catch (err) {
      console.warn('[Squideo] chip resolver flush failed', err);
      // Resolve with empty arrays so consumers fall through gracefully.
      for (const [, cbs] of callbacksByThread) {
        for (const cb of cbs) cb([]);
      }
    }
  }

  return {
    resolve(threadId, senderEmails = []) {
      const cached = cache.get(threadId);
      if (cached && (Date.now() - cached.fetchedAt) < cacheTtlMs) {
        return Promise.resolve(cached.result);
      }
      return new Promise((resolve) => {
        let entry = pending.get(threadId);
        if (!entry) {
          entry = { senderEmails: new Set(), callbacks: [] };
          pending.set(threadId, entry);
        }
        for (const e of senderEmails) if (e) entry.senderEmails.add(String(e).toLowerCase());
        entry.callbacks.push(resolve);
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
