import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';

const BASE = '/api/crm/reviews';

// Admin → Reviews. Moderation queue for the Google reviews that feed the
// scrolling banner on squideo.com.
//
// The sync pulls every review Google has; this decides which of them a visitor
// actually sees. Nothing is published on arrival — a new review lands as
// Pending and stays off the homepage until someone here says otherwise. That's
// the whole point of the screen: five stars is not the same as "we're happy for
// this to be the first thing a stranger reads about us".
const FILTERS = [
  { id: 'pending',  label: 'Pending' },
  { id: 'approved', label: 'On the site' },
  { id: 'rejected', label: 'Hidden' },
  { id: 'all',      label: 'All' },
];

export function ReviewsTab() {
  const { showMsg } = useStore();
  const [filter, setFilter] = useState('pending');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [drafts, setDrafts] = useState({});

  const load = useCallback(async (which) => {
    setLoading(true);
    try {
      setData(await api.get(`${BASE}?filter=${encodeURIComponent(which)}`));
      setSelected(new Set());
    } catch (err) {
      showMsg(err?.message || 'Could not load reviews');
    } finally {
      setLoading(false);
    }
  }, [showMsg]);

  useEffect(() => { load(filter); }, [filter, load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.post(`${BASE}/sync`, {});
      // The endpoint reports failures in the body rather than as a non-2xx, so
      // that a Google outage reads as a message here instead of a red toast
      // with no detail in it.
      if (r?.ok) {
        showMsg(`Pulled ${r.rows} reviews from Google${r.pending ? ` — ${r.pending} waiting for you` : ''}`);
      } else {
        showMsg(r?.error || 'Sync failed');
      }
      await load(filter);
    } catch (err) {
      showMsg(err?.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const decide = async (ids, approved) => {
    try {
      await api.post(`${BASE}/approve`, { ids, approved });
      await load(filter);
      const n = ids.length;
      showMsg(approved === null
        ? `${n} review${n === 1 ? '' : 's'} moved back to pending`
        : `${n} review${n === 1 ? '' : 's'} ${approved ? 'added to the site' : 'hidden'}`);
    } catch (err) {
      showMsg(err?.message || 'Could not save');
    }
  };

  const saveText = async (id) => {
    const text = drafts[id];
    if (text === undefined) return;
    try {
      await api.patch(`${BASE}/${encodeURIComponent(id)}/text`, { text });
      setDrafts((d) => { const next = { ...d }; delete next[id]; return next; });
      showMsg('Card text saved');
    } catch (err) {
      showMsg(err?.message || 'Could not save text');
    }
  };

  const reviews = data?.reviews || [];
  const counts = data?.counts || { pending: 0, approved: 0, rejected: 0 };
  const status = data?.status;

  const allShownSelected = reviews.length > 0 && reviews.every((r) => selected.has(r.id));
  const toggleAll = () => {
    setSelected(allShownSelected ? new Set() : new Set(reviews.map((r) => r.id)));
  };
  const toggleOne = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const selectedIds = useMemo(() => [...selected], [selected]);

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>Google reviews</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.6 }}>
        Feeds the scrolling review banner on squideo.com. Reviews sync from your Google Business
        Profile every morning, but nothing appears on the site until you add it here — so a new
        review never puts itself on the homepage overnight.
      </p>

      <div style={{
        background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
        padding: 16, marginBottom: 16, display: 'flex', flexWrap: 'wrap',
        alignItems: 'center', gap: 12,
      }}>
        <button onClick={sync} disabled={syncing} style={primaryBtn(syncing)}>
          {syncing ? 'Pulling from Google…' : 'Sync from Google'}
        </button>
        <div style={{ fontSize: 12, color: BRAND.muted, flex: '1 1 220px', lineHeight: 1.5 }}>
          {status
            ? (status.ok
                ? `Last sync ${new Date(status.ranAt).toLocaleString('en-GB')} — OK`
                : `Last sync failed: ${status.message}`)
            : 'Not synced yet.'}
          {data?.meta?.total_count ? (
            <> · Google shows {Number(data.meta.average_rating).toFixed(1)} from {data.meta.total_count} reviews.</>
          ) : null}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {FILTERS.map((f) => {
          const n = f.id === 'all'
            ? counts.pending + counts.approved + counts.rejected
            : counts[f.id];
          return (
            <button key={f.id} onClick={() => setFilter(f.id)} style={tabBtn(filter === f.id)}>
              {f.label}{typeof n === 'number' ? ` (${n})` : ''}
            </button>
          );
        })}
      </div>

      {selectedIds.length > 0 && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 2, background: BRAND.ink, color: 'white',
          borderRadius: 8, padding: '10px 14px', marginBottom: 12,
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 13,
        }}>
          <strong>{selectedIds.length} selected</strong>
          <button onClick={() => decide(selectedIds, true)} style={barBtn}>Add to site</button>
          <button onClick={() => decide(selectedIds, false)} style={barBtn}>Hide</button>
          <button onClick={() => setSelected(new Set())} style={{ ...barBtn, background: 'transparent' }}>Clear</button>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: BRAND.muted }}>Loading…</p>
      ) : !data?.configured ? (
        <Empty>
          Google Business Profile isn’t connected yet. Once the API credentials are set in Vercel,
          press <strong>Sync from Google</strong> and your reviews will appear here.
        </Empty>
      ) : reviews.length === 0 ? (
        <Empty>
          {filter === 'pending'
            ? 'Nothing waiting. New reviews will show up here after the next sync.'
            : 'Nothing in here yet.'}
        </Empty>
      ) : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: BRAND.muted, marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={allShownSelected} onChange={toggleAll} />
            Select all {reviews.length} shown
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {reviews.map((r) => (
              <ReviewRow
                key={r.id}
                review={r}
                checked={selected.has(r.id)}
                onToggle={() => toggleOne(r.id)}
                draft={drafts[r.id]}
                onDraft={(v) => setDrafts((d) => ({ ...d, [r.id]: v }))}
                onSaveText={() => saveText(r.id)}
                onDecide={(approved) => decide([r.id], approved)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReviewRow({ review, checked, onToggle, draft, onDraft, onSaveText, onDecide }) {
  const [open, setOpen] = useState(false);
  const shown = draft !== undefined ? draft : (review.displayText || '');
  const dirty = draft !== undefined && draft !== (review.displayText || '');

  return (
    <div style={{
      background: 'white', border: '1px solid ' + (checked ? BRAND.blue : BRAND.border),
      borderRadius: 10, padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start',
    }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 4 }} />

      {review.photo
        ? <img src={review.photo} alt="" width={36} height={36}
               style={{ borderRadius: '50%', objectFit: 'cover', flex: '0 0 auto' }} />
        : <div style={{
            width: 36, height: 36, borderRadius: '50%', flex: '0 0 auto',
            background: BRAND.border, color: BRAND.muted, display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
          }}>{(review.name || '?').slice(0, 1).toUpperCase()}</div>}

      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
          <strong style={{ fontSize: 14 }}>{review.name || 'Anonymous'}</strong>
          <span style={{ color: '#FBBC04', fontSize: 13, letterSpacing: 1 }}>
            {'★'.repeat(review.stars)}<span style={{ color: BRAND.border }}>{'★'.repeat(5 - review.stars)}</span>
          </span>
          {review.updateTime && (
            <span style={{ fontSize: 12, color: BRAND.muted }}>
              {new Date(review.updateTime).toLocaleDateString('en-GB')}
            </span>
          )}
          <StatusPill approved={review.approved} />
        </div>

        <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.55, color: BRAND.ink, whiteSpace: 'pre-wrap' }}>
          {review.comment || <em style={{ color: BRAND.muted }}>No written review — only a star rating.</em>}
        </p>

        {review.comment && (
          <>
            <button onClick={() => setOpen((o) => !o)} style={linkBtn}>
              {open ? 'Hide card text' : (review.displayText ? 'Edit card text (shortened)' : 'Shorten for the card')}
            </button>
            {open && (
              <div style={{ marginTop: 8 }}>
                <textarea
                  value={shown}
                  onChange={(e) => onDraft(e.target.value)}
                  rows={3}
                  placeholder="Leave blank to show the review exactly as written."
                  style={{
                    width: '100%', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.5,
                    padding: 8, borderRadius: 6, border: '1px solid ' + BRAND.border,
                    fontFamily: 'inherit', resize: 'vertical',
                  }}
                />
                <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>
                  The banner card shows about four lines. Trim to a natural sentence end rather than
                  letting it cut mid-word — this never changes the review on Google.
                </div>
                {dirty && <button onClick={onSaveText} style={{ ...primaryBtn(false), marginTop: 8 }}>Save card text</button>}
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '0 0 auto' }}>
        {review.approved !== true && (
          <button onClick={() => onDecide(true)} style={smallBtn(BRAND.blue, 'white')}>Add to site</button>
        )}
        {review.approved !== false && (
          <button onClick={() => onDecide(false)} style={smallBtn('white', BRAND.muted)}>Hide</button>
        )}
        {review.approved !== null && review.approved !== undefined && (
          <button onClick={() => onDecide(null)} style={{ ...smallBtn('white', BRAND.muted), border: 'none' }}>Undo</button>
        )}
      </div>
    </div>
  );
}

function StatusPill({ approved }) {
  if (approved === true)  return <Pill bg="#E6F7EE" fg="#1B7A47">On the site</Pill>;
  if (approved === false) return <Pill bg="#F2F4F6" fg={BRAND.muted}>Hidden</Pill>;
  return <Pill bg="#FFF6E5" fg="#9A6800">Pending</Pill>;
}

const Pill = ({ bg, fg, children }) => (
  <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999 }}>
    {children}
  </span>
);

const Empty = ({ children }) => (
  <div style={{
    background: 'white', border: '1px dashed ' + BRAND.border, borderRadius: 10,
    padding: 24, fontSize: 13, color: BRAND.muted, lineHeight: 1.6,
  }}>{children}</div>
);

const primaryBtn = (busy) => ({
  background: busy ? BRAND.muted : BRAND.blue, color: 'white', border: 'none',
  borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700,
  cursor: busy ? 'default' : 'pointer',
});

const tabBtn = (active) => ({
  background: active ? BRAND.ink : 'white',
  color: active ? 'white' : BRAND.ink,
  border: '1px solid ' + (active ? BRAND.ink : BRAND.border),
  borderRadius: 999, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
});

const smallBtn = (bg, fg) => ({
  background: bg, color: fg, border: '1px solid ' + (bg === 'white' ? BRAND.border : bg),
  borderRadius: 6, padding: '6px 10px', fontSize: 12, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap',
});

const barBtn = {
  background: 'rgba(255,255,255,.15)', color: 'white', border: '1px solid rgba(255,255,255,.3)',
  borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

const linkBtn = {
  background: 'none', border: 'none', padding: '6px 0 0', color: BRAND.blue,
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
};
