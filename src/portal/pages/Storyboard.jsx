// In-portal storyboard review — the storyboard twin of Review.jsx. Mounts the
// shared StoryboardRevision (pdf.js) surface for a logged-in client, scoped by
// the share token their portal already holds, fed by a small adapter over the
// anonymous /api/storyboards/* token endpoints so the CRM store stays out of the
// portal bundle. Identity comes from the session, so there's no name/email gate.
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { usePortal } from '../PortalContext.jsx';
import { navigate } from '../PortalApp.jsx';
import { StoryboardRevision } from '../../components/storyboard/StoryboardRevision.jsx';

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

const sbApi = {
  recordStoryboardViewer: (token, { name, email }) => req('POST', `/api/storyboards/viewer?token=${enc(token)}`, { name, email }),
  postStoryboardComment: (token, payload) => req('POST', `/api/storyboards/comment?token=${enc(token)}`, payload),
  editStoryboardComment: (token, id, body, viewerEmail) => req('PATCH', `/api/storyboards/comment?token=${enc(token)}&id=${enc(id)}`, { body, viewerEmail }),
  deleteStoryboardComment: (token, id, viewerEmail) => req('DELETE', `/api/storyboards/comment?token=${enc(token)}&id=${enc(id)}&viewerEmail=${enc(viewerEmail)}`),
  approveStoryboard: (token, storyboardId, approvedBy) => req('POST', `/api/storyboards/approve?token=${enc(token)}`, { storyboardId, approvedBy }),
  submitStoryboardFeedback: (token, storyboardId, name) => req('POST', `/api/storyboards/submit-feedback?token=${enc(token)}`, { storyboardId, name }),
  recordStoryboardView: (token, payload) => req('POST', `/api/storyboards/view?token=${enc(token)}`, payload).catch(() => {}),
  pollPublicStoryboard: (token, viewerEmail) => req('GET', `/api/storyboards/public?token=${enc(token)}${viewerEmail ? `&viewerEmail=${enc(viewerEmail)}` : ''}`),
  uploadStoryboardAsset: async (token, file, { onProgress } = {}) => {
    const { upload } = await import('@vercel/blob/client');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await upload('storyboard-assets/' + token + '/' + Date.now() + '-' + safeName, file, {
      access: 'public',
      handleUploadUrl: '/api/storyboards/asset-token?token=' + enc(token),
      contentType: file.type || 'application/octet-stream',
      multipart: true,
      onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
    });
    return { url: blob.url, name: file.name, type: file.type || null };
  },
};

export default function Storyboard({ token }) {
  const { user, showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const identity = useMemo(
    () => (user?.email ? { name: user.name || null, email: user.email } : null),
    [user],
  );

  useEffect(() => {
    let alive = true;
    sbApi.pollPublicStoryboard(token, identity?.email)
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
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>This storyboard is no longer available.</div>
      ) : !data ? (
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>Loading storyboard…</div>
      ) : (
        <div style={{ background: BRAND.paper, color: BRAND.ink }}>
          <StoryboardRevision token={token} data={data} api={sbApi} showMsg={showToast} identity={identity} />
        </div>
      )}
    </div>
  );
}
