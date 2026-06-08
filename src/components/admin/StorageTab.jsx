import React, { useEffect, useState } from 'react';
import { HardDrive, RefreshCw, ExternalLink, Database, Wallet, Plus, Trash2 } from 'lucide-react';
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
const fmtGb = (n) => (Number(n) || 0).toFixed((Number(n) || 0) >= 100 ? 0 : 2) + ' GB';
const num = (n) => (Number(n) || 0);

export function StorageTab() {
  const { state, actions } = useStore();
  const blob = state.blobUsage;
  const neon = state.neonUsage;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!blob) actions.loadBlobUsage({ refresh: false });
    if (!neon) actions.loadNeonUsage({ refresh: false });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshAll() {
    setLoading(true);
    try { await Promise.all([actions.loadBlobUsage({ refresh: true }), actions.loadNeonUsage({ refresh: true })]); }
    finally { setLoading(false); }
  }

  const blobUsd = num(blob?.estMonthlyStorageUsd);
  const neonUsd = neon?.configured ? num(neon?.costs?.total) : 0;
  const fixedUsd = (state.costItems || []).reduce((sum, it) => sum + num(it.amountUsd), 0);
  const grandTotal = blobUsd + neonUsd + fixedUsd;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Wallet size={20} color={BRAND.blue} />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Storage &amp; CRM costs</h2>
        <button onClick={refreshAll} disabled={loading} className="btn-ghost" style={{ marginLeft: 'auto' }}>
          <RefreshCw size={14} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Grand total */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <Stat label="Total CRM cost / mo (est.)" value={fmtUsd(grandTotal)}
          sub="Neon + Vercel Blob + fixed costs" big />
        <Stat label="Neon database" value={neon?.configured ? fmtUsd(neonUsd) : '—'}
          sub={neon?.configured ? 'this billing period' : neon?.error ? 'error — see below' : 'not configured'} />
        <Stat label="Vercel Blob storage" value={fmtUsd(blobUsd)} sub="storage only" />
        <Stat label="Fixed monthly costs" value={fmtUsd(fixedUsd)}
          sub={`${(state.costItems || []).length} item${(state.costItems || []).length === 1 ? '' : 's'}`} />
      </div>

      <NeonSection neon={neon} loading={loading} />
      <BlobSection blob={blob} loading={loading} />
      <FixedCostsSection items={state.costItems || []} onSave={actions.saveCostItems} />
    </div>
  );
}

/* ---------------- Neon ---------------- */
function NeonSection({ neon, loading }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <SectionHeader icon={Database} title="Neon database (Postgres)" />
      {!neon ? (
        <Muted>{loading ? 'Loading…' : 'No data yet.'}</Muted>
      ) : neon.error ? (
        <div style={{
          padding: 16, background: '#FEF2F2', border: '1px solid #FECACA',
          borderRadius: 10, color: '#991B1B', fontSize: 13, lineHeight: 1.6,
        }}>
          Couldn't load Neon usage: {neon.error}
          <div style={{ marginTop: 6, color: '#7F1D1D' }}>
            If your project is under an organisation, make sure the API key can access it
            (or set <code>NEON_ORG_ID</code> in Vercel), then hit Refresh.
          </div>
        </div>
      ) : !neon.configured ? (
        <div style={{
          padding: 16, background: '#FEF3C7', border: '1px solid #FCD34D',
          borderRadius: 10, color: '#92400E', fontSize: 13, lineHeight: 1.6,
        }}>
          Neon usage isn't available yet. Create an API key in the{' '}
          <a href="https://console.neon.tech/app/settings/api-keys" target="_blank" rel="noreferrer"
            style={{ color: '#92400E', fontWeight: 600 }}>Neon Console</a>{' '}
          (Account settings → API keys), then add it as <code>NEON_API_KEY</code> in your
          Vercel project environment variables. The rest of this page works without it.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat label="Compute" value={fmtUsd(neon.costs.compute)}
              sub={`${num(neon.usage.computeCuHours).toFixed(1)} CU-hours`} />
            <Stat label="Storage" value={fmtUsd(neon.costs.storage)}
              sub={fmtGb(neon.usage.storageGbMonth) + '-month'} />
            <Stat label="Egress (data transfer)" value={fmtUsd(neon.costs.egress)}
              sub={`${fmtGb(neon.usage.egressGb)} of ${neon.pricing.egressIncludedGb} GB included`} />
            <Stat label="Instant restore" value={fmtUsd(neon.costs.pitr)}
              sub={fmtGb(neon.usage.pitrGbMonth) + '-month'} />
          </div>
          <p style={{ fontSize: 12, color: BRAND.muted, marginTop: 14, lineHeight: 1.6 }}>
            <strong>Estimated</strong> from Neon Launch unit prices for this billing period to date
            {neon.period?.start ? ` (since ${new Date(neon.period.start).toLocaleDateString()})` : ''}
            {neon.projectName ? ` · project “${neon.projectName}”` : ''}. For exact billing see your{' '}
            <a href="https://console.neon.tech/app/billing" target="_blank" rel="noreferrer"
              style={{ color: BRAND.blue, textDecoration: 'none' }}>
              Neon billing page <ExternalLink size={11} />
            </a>. {neon.cached ? 'Figures cached up to 1h; Refresh recomputes.' : ''}
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------- Vercel Blob ---------------- */
function BlobSection({ blob, loading }) {
  const maxBytes = blob ? Math.max(1, ...(blob.breakdown || []).map(b => b.bytes)) : 1;
  return (
    <div style={{ marginBottom: 24 }}>
      <SectionHeader icon={HardDrive} title="Vercel Blob storage" />
      {!blob ? (
        <Muted>{loading ? 'Calculating…' : 'No data yet.'}</Muted>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <Stat label="Total stored" value={fmtBytes(blob.totalBytes)} sub={`${blob.totalCount.toLocaleString()} files`} />
            <Stat label="Est. storage cost / mo" value={fmtUsd(blob.estMonthlyStorageUsd)}
              sub={`${blob.pricing.includedGb} GB included, then $${blob.pricing.perGbUsd}/GB`} />
            <Stat label="Billable storage" value={fmtBytes(Math.max(0, blob.totalBytes - blob.pricing.includedGb * 1e9))}
              sub={`after the ${blob.pricing.includedGb} GB allowance`} />
          </div>

          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, fontWeight: 600, fontSize: 13, color: BRAND.ink }}>
              Where the space is going
            </div>
            {(blob.breakdown || []).length === 0 && (
              <div style={{ padding: 16, color: BRAND.muted, fontSize: 13 }}>No files stored yet.</div>
            )}
            {(blob.breakdown || []).map(b => (
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
            </a>{' '}for full billing. {blob.cached ? 'Figures cached up to 1h; Refresh recomputes.' : ''}
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------- Fixed monthly costs ---------------- */
function FixedCostsSection({ items, onSave }) {
  const [draft, setDraft] = useState(items);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-sync when the store updates and we have no unsaved edits.
  useEffect(() => { if (!dirty) setDraft(items); }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (next) => { setDraft(next); setDirty(true); };
  const edit = (id, field, value) => update(draft.map(it => it.id === id ? { ...it, [field]: value } : it));
  const remove = (id) => update(draft.filter(it => it.id !== id));
  const add = () => update([...draft, { id: 'cost_' + Date.now().toString(36), label: '', amountUsd: 0, note: '' }]);

  async function save() {
    setSaving(true);
    const cleaned = draft
      .filter(it => String(it.label).trim() || num(it.amountUsd))
      .map(it => ({ ...it, label: String(it.label).trim(), amountUsd: num(it.amountUsd), note: String(it.note || '').trim() }));
    try { await onSave(cleaned); setDirty(false); setDraft(cleaned); }
    finally { setSaving(false); }
  }

  const subtotal = draft.reduce((sum, it) => sum + num(it.amountUsd), 0);

  return (
    <div style={{ marginBottom: 8 }}>
      <SectionHeader icon={Wallet} title="Fixed monthly costs" />
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 8, padding: '8px 14px', borderBottom: '1px solid ' + BRAND.border, fontSize: 11, color: BRAND.muted, fontWeight: 600 }}>
          <span style={{ flex: '1 1 160px' }}>Service</span>
          <span style={{ flex: '2 1 240px' }}>Note</span>
          <span style={{ width: 110, textAlign: 'right' }}>$ / month</span>
          <span style={{ width: 28 }} />
        </div>

        {draft.length === 0 && (
          <div style={{ padding: 16, color: BRAND.muted, fontSize: 13 }}>No fixed costs yet. Add one below.</div>
        )}

        {draft.map(it => (
          <div key={it.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid ' + BRAND.border }}>
            <input value={it.label} onChange={e => edit(it.id, 'label', e.target.value)} placeholder="e.g. Resend"
              style={{ flex: '1 1 160px', ...inputStyle }} />
            <input value={it.note || ''} onChange={e => edit(it.id, 'note', e.target.value)} placeholder="optional note"
              style={{ flex: '2 1 240px', ...inputStyle }} />
            <div style={{ width: 110, display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
              <span style={{ color: BRAND.muted, fontSize: 13 }}>$</span>
              <input type="number" min="0" step="0.01" value={it.amountUsd}
                onChange={e => edit(it.id, 'amountUsd', e.target.value)}
                style={{ width: 80, textAlign: 'right', ...inputStyle }} />
            </div>
            <button onClick={() => remove(it.id)} className="btn-ghost" title="Remove"
              style={{ width: 28, padding: 4, color: BRAND.muted }}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
          <button onClick={add} className="btn-ghost"><Plus size={14} /> Add cost</button>
          <span style={{ marginLeft: 'auto', fontSize: 13, color: BRAND.ink, fontWeight: 600 }}>
            Subtotal {fmtUsd(subtotal)} / mo
          </span>
          <button onClick={save} disabled={!dirty || saving} className="btn">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  padding: '6px 8px', border: '1px solid ' + BRAND.border, borderRadius: 6,
  fontSize: 13, color: BRAND.ink, background: 'white',
};

function SectionHeader({ icon: Icon, title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <Icon size={16} color={BRAND.blue} />
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: BRAND.ink }}>{title}</h3>
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: BRAND.muted, fontSize: 14, padding: 16 }}>{children}</div>;
}

function Stat({ label, value, sub, big }) {
  return (
    <div style={{ flex: big ? '1 1 240px' : '1 1 180px', minWidth: 170, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16 }}>
      <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: big ? 30 : 24, fontWeight: 700, color: big ? BRAND.blue : BRAND.ink }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
