// /api/blob-usage — Vercel Blob storage usage + cost estimate for the Admin
// "Storage" tab. Lists every blob across the stores we use, sums sizes grouped
// by top-level prefix (category), and estimates the monthly *storage* cost.
//
// GET (settings.manage). Module-cached ~1h because list() counts as Advanced
// Operations; pass ?refresh=1 to recompute.
import { list } from '@vercel/blob';
import { cors, requirePermission } from './_lib/middleware.js';

// Storage pricing (Pro): $0.023 per GB-month, first 5 GB included.
const STORAGE_PRICE_PER_GB = 0.023;
const STORAGE_INCLUDED_GB = 5;

// The two stores this project writes to. The public Revisions store also holds
// storyboard + milestone assets; the default store holds private deal files.
const STORES = [
  { key: 'revisions', label: 'Revisions store (public)', token: process.env.REVISION_BLOB_READ_WRITE_TOKEN || process.env.REVIEW_BLOB_READ_WRITE_TOKEN },
  { key: 'default',   label: 'Default store (deal files)', token: process.env.BLOB_READ_WRITE_TOKEN },
];

// Friendly names for the top-level path prefixes we upload under.
const CATEGORY_LABEL = {
  'milestone-assets': 'Milestone uploads',
  'revision-videos':  'Video Revisions',
  'revision-assets':  'Revision comment files',
  'storyboard-pdfs':  'Storyboard Revisions',
  'storyboard-assets':'Storyboard comment files',
  'video-scripts':    'Scripts (legacy)',
  'deal-files':       'Deal files',
  'email-attachments':'Email attachments',
};

let cache = null; // { at, data }
const TTL_MS = 60 * 60 * 1000;

async function compute() {
  const categories = {}; // prefix -> { count, bytes, label }
  let totalBytes = 0, totalCount = 0;
  const storesSeen = [];

  for (const store of STORES) {
    if (!store.token) continue;
    storesSeen.push(store.key);
    let cursor;
    do {
      const res = await list({ token: store.token, cursor, limit: 1000 });
      for (const b of res.blobs || []) {
        const size = Number(b.size) || 0;
        totalBytes += size; totalCount += 1;
        const prefix = String(b.pathname || '').split('/')[0] || 'other';
        const cat = (categories[prefix] ||= { count: 0, bytes: 0, label: CATEGORY_LABEL[prefix] || prefix });
        cat.count += 1; cat.bytes += size;
      }
      cursor = res.hasMore ? res.cursor : null;
    } while (cursor);
  }

  const totalGB = totalBytes / 1e9;
  const billableGB = Math.max(0, totalGB - STORAGE_INCLUDED_GB);
  const estMonthlyStorageUsd = billableGB * STORAGE_PRICE_PER_GB;

  const breakdown = Object.entries(categories)
    .map(([prefix, v]) => ({ prefix, ...v }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes, totalCount, totalGB,
    estMonthlyStorageUsd,
    pricing: { perGbUsd: STORAGE_PRICE_PER_GB, includedGb: STORAGE_INCLUDED_GB },
    breakdown,
    stores: storesSeen,
    computedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const auth = await requirePermission(req, res, 'settings.manage');
  if (!auth) return;

  try {
    const refresh = req.query?.refresh;
    if (!refresh && cache && (Date.now() - cache.at) < TTL_MS) {
      return res.status(200).json({ ...cache.data, cached: true });
    }
    const data = await compute();
    cache = { at: Date.now(), data };
    return res.status(200).json({ ...data, cached: false });
  } catch (err) {
    console.error('[blob-usage]', err);
    return res.status(500).json({ error: err?.message || 'Could not compute blob usage' });
  }
}
