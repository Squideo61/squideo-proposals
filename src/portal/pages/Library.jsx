// The video library: finished files from each project's Drive "Signed Off"
// folder, grouped by project, downloadable any time.
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, fmtBytes, fmtDate } from '../components.jsx';
import { Film, Download, Clapperboard } from 'lucide-react';

export default function Library() {
  const { companyId } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!companyId) return;
    setData(null);
    portalApi.get(`library?companyId=${encodeURIComponent(companyId)}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [companyId]);

  const download = (dealId, fileId) => {
    window.location.href = `/api/portal/download?scope=library&dealId=${encodeURIComponent(dealId)}&id=${encodeURIComponent(fileId)}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Your video library</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13.5, color: BRAND.muted }}>
          Every finished video we've delivered — download and share anywhere, any time.
        </p>
      </div>

      {error && <Card><EmptyState title="Couldn't load your library" body={error} /></Card>}

      {!error && !data && (
        <Card><div style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', padding: 24 }}>Fetching your videos…</div></Card>
      )}

      {data && (data.projects || []).length === 0 && (
        <Card>
          <EmptyState
            icon={<Clapperboard size={34} />}
            title="Your finished videos will live here"
            body={data.unavailable
              ? 'The library is temporarily unavailable — try again shortly.'
              : 'As soon as a video is signed off and delivered, it appears here ready to download.'}
          />
        </Card>
      )}

      {data && (data.projects || []).map((p) => (
        <Card key={p.dealId}>
          <SectionHeading>{p.title}</SectionHeading>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 12 }}>
            {p.files.map((f) => (
              <div key={f.fileId} style={{
                border: `1px solid ${BRAND.border}`, borderRadius: 12, padding: 14,
                display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: 9, display: 'grid', placeItems: 'center',
                    background: BRAND.blue + '1a', color: BRAND.blue, flexShrink: 0,
                  }}>
                    <Film size={19} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>
                      {f.name}
                    </div>
                    <div style={{ fontSize: 11.5, color: BRAND.muted }}>
                      {[f.sizeBytes != null ? fmtBytes(f.sizeBytes) : null, fmtDate(f.createdTime)].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
                <button className="btn" onClick={() => download(p.dealId, f.fileId)} style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Download size={15} /> Download
                </button>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
