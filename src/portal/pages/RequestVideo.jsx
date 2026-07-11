// Request a new video — the public quote form's project/timeline/budget steps
// with the contact step skipped (identity comes from the session) and the 10%
// portal discount front and centre. Lands in the CRM quote-requests list with
// a "Portal · 10%" pill.
import React, { useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, fmtBytes } from '../components.jsx';
import { Sparkles, Upload, CheckCircle2, X } from 'lucide-react';

// Mirrors the public form's options (src/components/QuoteRequestForm.jsx).
const TIMELINE_OPTIONS = [
  "~4 weeks - It's a priority",
  "6-8 weeks - I'm happy to slot into Squideo's normal production schedule",
  "I'm not ready yet, but I'm open to booking in early for a discount on my quote",
];

const MAX_FILES = 5;

export default function RequestVideo() {
  const { user, companyId, showToast } = usePortal();
  const [projectDetails, setProjectDetails] = useState('');
  const [timeline, setTimeline] = useState('');
  const [budget, setBudget] = useState('');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const addFiles = async (list) => {
    const remaining = MAX_FILES - files.length;
    const toUpload = Array.from(list || []).slice(0, remaining);
    if (!toUpload.length) return;
    setUploading(true);
    try {
      const uploaded = [];
      for (const file of toUpload) {
        // Reuses the public quote-request upload endpoint (same blob store the
        // CRM's quote-request view reads from).
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch('/api/quote-requests?action=upload', {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
          body: file,
        });
        // eslint-disable-next-line no-await-in-loop
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || 'Upload failed');
        uploaded.push(json);
      }
      setFiles((f) => [...f, ...uploaded]);
    } catch (err) {
      showToast(err.message);
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!projectDetails.trim()) return setError('Tell us a little about the video you need.');
    setBusy(true);
    try {
      await portalApi.post(`request-video?companyId=${encodeURIComponent(companyId)}`, {
        projectDetails: projectDetails.trim(),
        timeline: timeline || null,
        budget: budget.trim() || null,
        files,
      });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center', padding: 36 }}>
        <CheckCircle2 size={44} color="#16A34A" style={{ margin: '0 auto 14px' }} />
        <h1 style={{ margin: '0 0 10px', fontSize: 21, fontWeight: 800, color: BRAND.ink }}>Request received 🎉</h1>
        <p style={{ margin: '0 0 8px', fontSize: 14, color: BRAND.ink, lineHeight: 1.6 }}>
          Thanks{user?.name ? `, ${user.name.split(' ')[0]}` : ''} — our team has your request and your
          <strong style={{ color: '#16A34A' }}> 10% portal discount is locked in</strong>.
        </p>
        <p style={{ margin: '0 0 22px', fontSize: 13, color: BRAND.muted }}>
          We'll come back with a tailored quote, usually within one working day.
        </p>
        <a className="btn" href="#/">Back to my projects</a>
      </Card>
    );
  }

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{
        background: 'linear-gradient(120deg, #0F2A3D, #14405e)',
        borderRadius: 16, padding: '22px 24px', color: '#fff',
      }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#16A34A', borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 800, marginBottom: 10 }}>
          <Sparkles size={13} /> PORTAL EXCLUSIVE — 10% OFF
        </div>
        <h1 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800 }}>Request a new video</h1>
        <p style={{ margin: 0, fontSize: 13.5, color: '#B9CBD6', lineHeight: 1.55 }}>
          Because you're requesting through the portal, your quote comes with an exclusive
          <strong style={{ color: '#7EE2A8' }}> 10% discount</strong> — and we already have your details, so this takes under a minute.
        </p>
      </div>

      <Card>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ fontSize: 12.5, color: BRAND.muted }}>
            Requesting as <strong style={{ color: BRAND.ink }}>{user?.name || user?.email}</strong>
            {user?.companies?.length ? <> for <strong style={{ color: BRAND.ink }}>{user.companies.find((c) => c.id === companyId)?.name}</strong></> : null}
          </div>

          <label>
            <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>What video do you need?</div>
            <textarea
              className="input"
              rows={5}
              required
              placeholder="Tell us about the project — what it's for, roughly how long, style you like, where it'll be used…"
              value={projectDetails}
              onChange={(e) => setProjectDetails(e.target.value)}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </label>

          <label>
            <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>When do you need it?</div>
            <select className="input" value={timeline} onChange={(e) => setTimeline(e.target.value)} style={{ width: '100%' }}>
              <option value="">Select a timeline (optional)</option>
              {TIMELINE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>

          <label>
            <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>Rough budget (optional)</div>
            <textarea
              className="input"
              rows={2}
              placeholder="Even a rough guess helps us give you useful options faster."
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </label>

          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>Brief or script (optional)</div>
            <label className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: BRAND.blue }}>
              <Upload size={14} /> {uploading ? 'Uploading…' : 'Attach files'}
              <input type="file" hidden multiple disabled={uploading || files.length >= MAX_FILES} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            {files.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {files.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: BRAND.ink }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</span>
                    <span style={{ color: BRAND.muted }}>{fmtBytes(f.sizeBytes)}</span>
                    <button type="button" className="btn-icon" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}><X size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
              {error}
            </div>
          )}

          <button className="btn" type="submit" disabled={busy || uploading} style={{ padding: '12px 0', fontSize: 15, background: '#16A34A' }}>
            {busy ? 'Sending…' : 'Send my request — with 10% off'}
          </button>
          <div style={{ fontSize: 11.5, color: BRAND.muted, textAlign: 'center' }}>
            No commitment — you'll get a tailored quote to review first.
          </div>
        </form>
      </Card>
    </div>
  );
}
