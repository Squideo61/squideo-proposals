import React, { useEffect, useState } from 'react';
import { HardDrive, RefreshCw, ExternalLink } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}
const fmtUsd = (n) => '$' + (Number(n) || 0).toFixed(2);

export function StorageTab() {
  const { state, actions } = useStore();
  const data = state.blobUsage;
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (!data) load(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(refresh) {
    setLoading(true);
    try { await actions.loadBlobUsage({ refresh }); }
    finally { setLoading(false); }
  }

  const maxBytes = data ? Math.max(1, ...(data.breakdown || []).map(b => b.bytes)) : 1;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <HardDrive size={20} color={BRAND.blue} />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Storage usage</h2>
        <button onClick={() => load(true)} disabled={loading} className="btn-ghost" style={{ marginLeft: 'auto' }}>
          <RefreshCw size={14} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {!data ? (
        <div style={{ color: BRAND.muted, fontSize: 14, padding: 24 }}>{loading ? 'Calculating…' : 'No data yet.'}</div>
      ) : (
        <>
          {/* Headline cards */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <Stat label="Total stored" value={fmtBytes(data.totalBytes)} sub={`${data.totalCount.toLocaleString()} files`} />
            <Stat label="Est. storage cost / mo" value={fmtUsd(data.estMonthlyStorageUsd)}
              sub={`${data.pricing.includedGb} GB included, then $${data.pricing.perGbUsd}/GB`} />
            <Stat label="Billable storage" value={fmtBytes(Math.max(0, data.totalBytes - data.pricing.includedGb * 1e9))}
              sub={`after the ${data.pricing.includedGb} GB allowance`} />
          </div>

          {/* Breakdown by category */}
          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, fontWeight: 600, fontSize: 13, color: BRAND.ink }}>
              Where the space is going
            </div>
            {(data.breakdown || []).length === 0 && (
              <div style={{ padding: 16, color: BRAND.muted, fontSize: 13 }}>No files stored yet.</div>
            )}
            {(data.breakdown || []).map(b => (
              <div key={b.prefix} style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
                  <span style={{ fontWeight: 600, color: BRAND.ink, fontSize: 13 }}>{b.label}</span>
                  <span style={{ fontSize: 11, color: BRAND.muted }}>{b.count.toLocaleString()} file{b.count === 1 ? '' : 's'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: BRAND.ink, fontWeight: 600 }}>{fmtBytes(b.bytes)}</span>
                </div>
                <div style={{ height: 6, background: BRAND.paper, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: (b.bytes / maxBytes * 100) + '%', height: '100%', background: BRAND.blue }} />
                </div>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 12, color: BRAND.muted, marginTop: 14, lineHeight: 1.6 }}>
            This is a <strong>storage-only</strong> estimate. Data transfer (viewing/downloading files) is also usage-based
            and isn't counted here — see your{' '}
            <a href="https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fobservability%2Fblob&title=Blob+Observability"
              target="_blank" rel="noreferrer" style={{ color: BRAND.blue, textDecoration: 'none' }}>
              Vercel Blob dashboard <ExternalLink size={11} />
            </a>{' '}for full billing. {data.cached ? 'Figures cached up to 1h; Refresh recomputes.' : ''}
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div style={{ flex: '1 1 200px', minWidth: 180, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16 }}>
      <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: BRAND.ink }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
