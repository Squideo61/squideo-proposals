// Admin → Testing: clear out Gmail drafts that older deploys filed as sent mail.
//
// Gmail writes a new message for every draft autosave and deletes the one
// before it. The CRM's sync treated each of those like a genuine send, so a
// deal thread could show four "OUT" emails — successive half-finished versions
// of the same template — above the one message the client actually received.
// The sync now refuses drafts; this is the mop-up for what is already stored.
//
// Deliberately two steps. "Check" only reports, so you can see which messages
// it means before anything is deleted, and the remove button then names the
// count it is about to act on.
import React, { useState } from 'react';
import { MailX, Search, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';

const DAYS = 90;

export function EmailMaintenancePanel() {
  const [busy, setBusy] = useState(null); // 'check' | 'apply'
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  const run = async (apply) => {
    setBusy(apply ? 'apply' : 'check');
    setError(null);
    try {
      const r = await api.post('/api/crm/gmail/prune-drafts', { apply, days: DAYS });
      setReport(r);
    } catch (err) {
      setError(err?.message || 'The sweep failed');
    } finally {
      setBusy(null);
    }
  };

  const found = report?.draftsFound ?? 0;

  return (
    <div style={{ maxWidth: 720, marginTop: 32, paddingTop: 24, borderTop: '1px solid ' + BRAND.border }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <MailX size={20} color={BRAND.blue} /> Drafts filed as sent email
      </h2>
      <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px', lineHeight: 1.5 }}>
        Gmail saves a new copy of a draft every time you pause typing, and the CRM used to file each of
        those as a sent email — so a thread could look like four emails to the client when only one went
        out. New mail is no longer affected. This checks the last {DAYS} days against Gmail itself and
        removes the ones that were never sent. <strong>Check</strong> first: it only reports.
      </p>

      {error && (
        <div style={{ fontSize: 12.5, color: '#9F1239', background: '#FFF1F2', border: '1px solid #FECDD3', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={!!busy} onClick={() => run(false)} style={{ fontSize: 13 }}>
          <Search size={14} /> {busy === 'check' ? 'Checking…' : 'Check'}
        </button>
        {!!found && !report.apply && (
          <button className="btn-ghost is-danger" disabled={!!busy} onClick={() => run(true)} style={{ fontSize: 13 }}>
            <Trash2 size={14} /> {busy === 'apply' ? 'Removing…' : `Remove ${found} draft${found === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {report && (
        <div style={{ marginTop: 16, fontSize: 12.5, color: BRAND.ink, lineHeight: 1.7 }}>
          <div>
            Checked <strong>{report.threadsChecked}</strong> conversation{report.threadsChecked === 1 ? '' : 's'}
            {report.threadsSkipped > 0 && <> (skipped {report.threadsSkipped} we couldn&rsquo;t read from Gmail)</>}.
          </div>
          <div>
            {report.apply
              ? <>Removed <strong>{report.draftsRemoved}</strong> draft{report.draftsRemoved === 1 ? '' : 's'}.</>
              : <>Found <strong>{found}</strong> draft{found === 1 ? '' : 's'} filed as sent mail.</>}
          </div>
          {report.more && (
            <div style={{ color: BRAND.muted }}>
              There are older conversations still to check — run it again to carry on.
            </div>
          )}
          {!!report.sample?.length && (
            <div style={{ marginTop: 10, border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
              {report.sample.map((s) => (
                <div key={s.gmailMessageId} style={{ display: 'flex', gap: 10, justifyContent: 'space-between', padding: '7px 10px', borderTop: '1px solid ' + BRAND.border, fontSize: 12 }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.subject || '(no subject)'}
                  </span>
                  <span style={{ color: BRAND.muted, flexShrink: 0 }}>
                    {s.sentAt ? new Date(s.sentAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : ''} · {s.reason}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
