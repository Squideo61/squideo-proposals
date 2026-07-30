// Admin → Testing: one-click "client journey" demo. Seeds a self-contained
// demo project (test company + a signed 50/50 deal in production + a revision
// with a sample draft + a portal invite to your own email) so you can walk the
// whole client experience — including the in-portal revision review and the
// gated download — without a real client. One click to tear it all down.
import React, { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Trash2, PlayCircle, KeyRound, Film, ExternalLink, Copy, Check } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';

// Step 1 can't be a plain link: invite tokens are stored hashed, so a link
// issued at seed time is unreadable once the page reloads — which used to leave
// this panel with no way into the portal at all. Mint a fresh one per click.
function SignInRow({ hasAccount, onOpen, busy }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
      <KeyRound size={16} color={BRAND.blue} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink }}>1. Open the portal as the demo client</div>
        <div style={{ fontSize: 11.5, color: BRAND.muted }}>
          {hasAccount
            ? 'Signs you straight in as the demo client — a fresh one-shot link each time.'
            : 'Opens your portal invite: set a password once, and you’re the demo client.'}
        </div>
      </div>
      <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={onOpen}>
        <ExternalLink size={13} /> {busy ? 'Opening…' : 'Open'}
      </button>
    </div>
  );
}

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
  const [linking, setLinking] = useState(false);
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
      flash('Demo ready — use “Open the portal as the demo client” below to log in as the client.');
    } catch (err) { flash(err.message || 'Could not seed the demo'); } finally { setBusy(false); }
  };

  // Open the tab synchronously (before the await) so the browser attributes it
  // to the click and doesn't treat it as a pop-up.
  const openPortal = async () => {
    const tab = window.open('', '_blank', 'noopener');
    setLinking(true);
    try {
      const r = await api.post('/api/crm/demo?op=portal-link', {});
      if (tab) tab.location = r.url; else window.location.href = r.url;
    } catch (err) {
      if (tab) tab.close();
      flash(err.message || 'Could not open the portal');
    } finally { setLinking(false); }
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
        client or going through the whole sign→pay process. It starts with <strong>no drafts</strong>: open the demo
        video, drop a storyboard/video draft on its milestone, then <strong>Submit to client for review</strong> — only
        then does it appear in the client&rsquo;s portal. Accept the portal invite with your own email to become the
        “client”. Delete it any time to remove all the test data.
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
            <SignInRow hasAccount={!!data.hasPortalAccount} busy={linking} onOpen={openPortal} />
            <LinkRow icon={PlayCircle} label="2. Open the project in the portal" hint="The client's project page — phase bar, tasks, reviews and (once released) the download." url={data.portalProjectUrl} />
            <LinkRow icon={Film} label="Video review inside the portal" hint="Appears once you've submitted a video draft to the client." url={data.portalReviewUrl} />
            <LinkRow icon={Film} label="Storyboard review inside the portal" hint="Appears once you've submitted a storyboard draft to the client." url={data.portalStoryboardUrl} />
            <LinkRow icon={ExternalLink} label="Video review via the anonymous share link" hint="What a client sees from an emailed link (name/email gate)." url={data.reviewUrl} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-ghost" disabled={busy} onClick={seed} style={{ fontSize: 12.5 }} title="Re-create anything missing from the demo project and refresh these links">
              Refresh demo
            </button>
            <button className="btn-ghost is-danger" disabled={busy} onClick={remove} style={{ fontSize: 12.5 }}>
              <Trash2 size={14} /> Delete demo project
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 14, lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 6px' }}>
              To create a review: open the demo video in the CRM (Production board → the video), open the
              <strong> Storyboard</strong> or <strong>Video</strong> milestone, drop a draft on it, then
              <strong> Submit to client for review</strong>. It then shows in the client&rsquo;s portal
              <strong> “Reviews &amp; feedback”</strong> card (below “Videos”) and the links above light up.
            </p>
            <p style={{ margin: 0 }}>
              Tip: to test the payment-gated download, open the deal in the CRM and use “Release now” on its Client-portal
              card (simulates the balance being settled), then the download unlocks in the portal.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
