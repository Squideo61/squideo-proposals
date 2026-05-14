// Read-only view of suspected duplicate Xero contacts. We don't auto-merge
// (Xero has no programmatic merge API, and a naive reassign+archive would
// break payments, repeating invoices, credit notes, and locked periods).
// Operators merge in Xero's UI, then click "Refresh" to update the mirror.

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, AlertTriangle, CheckCircle } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { api } from '../../api.js';

export function XeroDuplicatesView({ onBack }) {
  const { showMsg } = useStore();
  const isMobile = useIsMobile();
  const [clusters, setClusters] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => {
    api.get('/api/crm/xero-contacts/duplicates')
      .then((r) => setClusters(r.clusters || []))
      .catch((err) => { showMsg?.(err.message || 'Failed to load duplicates', 'error'); setClusters([]); });
  }, [showMsg]);

  useEffect(() => { reload(); }, [reload]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const r = await api.post('/api/crm/xero-contacts/sync');
      showMsg?.(`Re-synced ${r.upserts} Xero contacts`, 'success');
      reload();
    } catch (err) {
      showMsg?.(err.message || 'Sync failed (admin only)', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <button onClick={handleRefresh} disabled={refreshing} className="btn-ghost">
          <RefreshCw size={14} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
          {refreshing ? 'Refreshing…' : 'Refresh from Xero'}
        </button>
      </header>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertTriangle size={22} color="#B45309" /> Duplicate Xero contacts
        </h1>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
          Contacts in Xero whose names normalize to the same value (after stripping <code>Ltd</code>, <code>Limited</code>, punctuation, etc.) are grouped below.
          Merge them inside Xero's UI — Xero doesn't offer a merge API, and automated reassign+archive would corrupt payments,
          repeating invoices, and credit notes attached to the duplicate.
        </p>
        <p style={{ margin: 0, fontSize: 12, color: BRAND.muted, lineHeight: 1.5 }}>
          <strong>Workflow:</strong> open the duplicate in Xero, use Xero's "Merge" feature on the contact page, then click "Refresh from Xero" above.
        </p>
      </div>

      {clusters === null && (
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>
      )}

      {clusters && clusters.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12 }}>
          <CheckCircle size={32} color="#16A34A" style={{ margin: '0 auto 12px' }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: BRAND.ink }}>No duplicates detected</div>
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>Every active Xero contact normalises to a unique name.</div>
        </div>
      )}

      {clusters && clusters.length > 0 && (
        <>
          <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 8 }}>
            <strong style={{ color: BRAND.ink }}>{clusters.length}</strong> cluster{clusters.length === 1 ? '' : 's'} found.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {clusters.map((cluster, i) => (
              <ClusterCard key={i} cluster={cluster} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ClusterCard({ cluster }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
        {cluster.length} matching contacts
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {cluster.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 6 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.name}
              </div>
              <div style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.email || '—'}
                {c.defaultCurrency && ` · ${c.defaultCurrency}`}
                {c.xeroUpdatedAt && ` · updated ${new Date(c.xeroUpdatedAt).toLocaleDateString('en-GB')}`}
              </div>
            </div>
            <a
              href={`https://go.xero.com/Contacts/View/${encodeURIComponent(c.id)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <ExternalLink size={11} /> Open in Xero
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
