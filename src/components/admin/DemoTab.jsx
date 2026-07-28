// Admin → Testing: one-click "client journey" demo. Seeds a self-contained
// demo project (test company + a signed 50/50 deal in production + a revision
// with a sample draft + a portal invite to your own email) so you can walk the
// whole client experience — including the in-portal revision review and the
// gated download — without a real client. One click to tear it all down.
import React, { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Trash2, PlayCircle, KeyRound, Film, ExternalLink, Copy, Check } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';

function LinkRow({ icon: Icon, label, hint, url }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  const copy = () => { navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
      <Icon size={16} color={BRAND.blue} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink }}>{label}</div>
        {hint && <div style={{ fontSize: 11.5, color: BRAND.muted }}>{hint}</div>}
      </div>
      <button className="btn-ghost" style={{ fontSize: 12 }} onClick={copy} title="Copy link">
        {copied ? <Check size={13} color="#16A34A" /> : <Copy size={13} />}
      </button>
      <a className="btn" style={{ fontSize: 12, textDecoration: 'none' }} href={url} target="_blank" rel="noreferrer">
        <ExternalLink size={13} /> Open
      </a>
    </div>
  );
}

export function DemoTab() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    api.get('/api/crm/demo').then(setData).catch(() => setData({ exists: false }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (m) => { setNotice(m); window.setTimeout(() => setNotice(null), 4000); };

  const seed = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/crm/demo?op=seed', {});
      setData({ exists: true, ...r });
      flash(r.inviteUrl ? 'Demo ready — accept the portal invite below to log in as the client.' : 'Demo ready.');
      if (!r.draftAttached) flash('Demo ready, but the sample draft video could not be attached — upload one from the Revisions board to test the player.');
    } catch (err) { flash(err.message || 'Could not seed the demo'); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm('Delete the demo project and all its test data (company, deal, revision, portal invite)?')) return;
    setBusy(true);
    try {
      await api.post('/api/crm/demo?op=delete', {});
      setData({ exists: false });
      flash('Demo project deleted.');
    } catch (err) { flash(err.message || 'Could not delete the demo'); } finally { setBusy(false); }
  };

  const exists = data?.exists;

  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <FlaskConical size={20} color={BRAND.blue} /> Client journey demo
      </h2>
      <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px', lineHeight: 1.5 }}>
        Seeds a self-contained test project so you can experience exactly what a client sees — the portal,
        the revision review (comment &amp; approve), sign-off and the payment-gated download — without a real
        client or going through the whole sign→pay process. Accept the portal invite with your own email to
        become the “client”. Delete it any time to remove all the test data.
      </p>

      {notice && (
        <div style={{ fontSize: 12.5, color: '#0B6E93', background: '#EAF7FC', border: '1px solid #A9E1F5', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
          {notice}
        </div>
      )}

      {!exists ? (
        <button className="btn" disabled={busy} onClick={seed} style={{ fontSize: 13 }}>
          <FlaskConical size={15} /> {busy ? 'Seeding…' : 'Seed demo project'}
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            <LinkRow icon={KeyRound} label="1. Accept your portal invite" hint="Sets a password and logs you into the portal as the demo client." url={data.inviteUrl} />
            <LinkRow icon={PlayCircle} label="2. Open the project in the portal" hint="The client's project page — phase bar, tasks, reviews and (once released) the download." url={data.portalProjectUrl} />
            <LinkRow icon={Film} label="Video review inside the portal" hint="The in-portal video review — comment and approve as the client." url={data.portalReviewUrl} />
            <LinkRow icon={Film} label="Storyboard review inside the portal" hint="The in-portal storyboard (PDF) review — comment and approve as the client." url={data.portalStoryboardUrl} />
            <LinkRow icon={ExternalLink} label="Video review via the anonymous share link" hint="What a client sees from an emailed link (name/email gate)." url={data.reviewUrl} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-ghost" disabled={busy} onClick={seed} style={{ fontSize: 12.5 }} title="Re-issue the portal invite and refresh links">
              Refresh invite
            </button>
            <button className="btn-ghost is-danger" disabled={busy} onClick={remove} style={{ fontSize: 12.5 }}>
              <Trash2 size={14} /> Delete demo project
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 14, lineHeight: 1.5 }}>
            Tip: to test the payment-gated download, open the deal in the CRM and use “Release now” on its Client-portal
            card (simulates the balance being settled), then the download unlocks in the portal.
          </p>
        </>
      )}
    </div>
  );
}
