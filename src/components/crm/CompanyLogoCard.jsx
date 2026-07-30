// The client organisation's own logo, uploaded once here rather than per
// proposal. It pre-fills clientLogo on every NEW proposal for this client (an
// existing proposal keeps whatever it was sent with — it's a signed snapshot)
// and is what their client portal shows in the header and in portal emails.
//
// Stored as a data URL on companies.logo, the same representation proposals
// already use, so /api/portal-logo serves it unchanged.
import React, { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Card } from './Card.jsx';
import { LogoUploader } from '../LogoUploader.jsx';

export function CompanyLogoCard({ companyId, companyName, onSaved }) {
  const { showMsg } = useStore();
  const [logo, setLogo] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!companyId) return;
    api.get('/api/crm/companies/' + encodeURIComponent(companyId) + '/logo')
      .then((r) => { setLogo(r?.logo || null); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  // LogoUploader hands back a data URL (or null on Remove). Save immediately —
  // there's nothing else on this card to batch it with.
  const save = async (next) => {
    const previous = logo;
    setLogo(next);
    setBusy(true);
    try {
      await api.post('/api/crm/companies/' + encodeURIComponent(companyId) + '/logo', { logo: next });
      showMsg?.(next ? 'Logo saved' : 'Logo removed', 'success');
      onSaved?.();
    } catch (err) {
      setLogo(previous);
      showMsg?.(err.message || 'Could not save the logo', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={<><ImageIcon size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Logo</>}>
      <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Used on every new proposal for {companyName || 'this client'} and shown in their client portal.
        Proposals already sent keep the logo they were sent with.
      </div>
      {!loaded ? (
        <div style={{ fontSize: 12.5, color: BRAND.muted, fontStyle: 'italic', padding: '10px 4px' }}>Loading…</div>
      ) : (
        <div style={{ opacity: busy ? 0.6 : 1, pointerEvents: busy ? 'none' : undefined }}>
          <LogoUploader logo={logo} onChange={save} showMsg={showMsg} />
        </div>
      )}
    </Card>
  );
}
