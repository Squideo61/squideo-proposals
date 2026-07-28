// In-portal video review: mounts the shared VideoRevision surface for a
// logged-in client, scoped by the share token their portal already holds. Data
// access goes straight to the anonymous /api/revisions/* token endpoints via a
// small adapter (same method set as the CRM store's revision actions), so the
// CRM store never enters the portal bundle. Identity comes from the session, so
// there's no name/email gate.
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { usePortal } from '../PortalContext.jsx';
import { navigate } from '../PortalApp.jsx';
import { VideoRevision } from '../../components/revision/VideoRevision.jsx';

const enc = encodeURIComponent;

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let m = 'Something went wrong';
    try { m = (await res.json()).error || m; } catch { /* non-JSON */ }
    throw new Error(m);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// Mirrors the store's revision actions (same signatures) so VideoRevision runs
// unchanged. Token-authorised; the portal user legitimately holds the token.
const revApi = {
  recordRevisionViewer: (token, { name, email }) => req('POST', `/api/revisions/viewer?token=${enc(token)}`, { name, email }),
  postRevisionComment: (token, payload) => req('POST', `/api/revisions/comment?token=${enc(token)}`, payload),
  editRevisionComment: (token, id, body, viewerEmail) => req('PATCH', `/api/revisions/comment?token=${enc(token)}&id=${enc(id)}`, { body, viewerEmail }),
  deleteRevisionComment: (token, id, viewerEmail) => req('DELETE', `/api/revisions/comment?token=${enc(token)}&id=${enc(id)}&viewerEmail=${enc(viewerEmail)}`),
  approveRevision: (token, videoId, approvedBy) => req('POST', `/api/revisions/approve?token=${enc(token)}`, { videoId, approvedBy }),
  submitRevisionFeedback: (token, videoId, name) => req('POST', `/api/revisions/submit-feedback?token=${enc(token)}`, { videoId, name }),
  recordRevisionView: (token, payload) => req('POST', `/api/revisions/view?token=${enc(token)}`, payload).catch(() => {}),
  pollPublicRevision: (token, viewerEmail) => req('GET', `/api/revisions/public?token=${enc(token)}${viewerEmail ? `&viewerEmail=${enc(viewerEmail)}` : ''}`),
  uploadRevisionAsset: async (token, file, { onProgress } = {}) => {
    const { upload } = await import('@vercel/blob/client');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await upload('revision-assets/' + token + '/' + Date.now() + '-' + safeName, file, {
      access: 'public',
      handleUploadUrl: '/api/revisions/asset-token?token=' + enc(token),
      contentType: file.type || 'application/octet-stream',
      multipart: true,
      onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
    });
    return { url: blob.url, name: file.name, type: file.type || null };
  },
};

export default function Review({ token }) {
  const { user, showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const identity = useMemo(
    () => (user?.email ? { name: user.name || null, email: user.email } : null),
    [user],
  );

  useEffect(() => {
    let alive = true;
    revApi.pollPublicRevision(token, identity?.email)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [token, identity?.email]);

  return (
    <div>
      <button
        onClick={() => navigate('#/')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: BRAND.blue, cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: '4px 0', marginBottom: 8, fontFamily: 'inherit' }}
      >
        <ArrowLeft size={14} /> Back to projects
      </button>
      {error ? (
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>This review is no longer available.</div>
      ) : !data ? (
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>Loading review…</div>
      ) : (
        <div style={{ background: BRAND.paper, color: BRAND.ink }}>
          <VideoRevision token={token} data={data} api={revApi} showMsg={showToast} identity={identity} />
        </div>
      )}
    </div>
  );
}
