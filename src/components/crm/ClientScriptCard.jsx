// "Script & visual direction" on the deal page — the staff mirror of the client
// portal stage of the same name (src/portal/pages/Script.jsx).
//
// Clients often send a script by email long before the deal closes, so the whole
// point of the checkbox here is to stop the portal asking again: tick it and the
// client's step reads "we already have your script". They can still upload newer
// versions at any time — every one lands in the list below and pings the team.
import React, { useState } from 'react';
import { Check, Download, FileText, Palette, PenLine } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { fileSizeLabel, formatRelativeTime } from '../../utils.js';
import { Card, Empty } from './Card.jsx';

const TONE = {
  received: { bg: '#F0FDF4', border: '#BBF7D0', color: '#15803D' },
  squideo:  { bg: '#EAF7FC', border: '#A9E1F5', color: '#0B6E93' },
  waiting:  { bg: '#FFFBEB', border: '#FDE68A', color: '#B45309' },
};

export function ClientScriptCard({ dealId, clientScript }) {
  const { actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);

  const status = clientScript?.status || null;
  const files = clientScript?.files || [];
  const uploaded = files.length > 0;
  const tone = TONE[status === 'received' ? 'received' : status === 'squideo' ? 'squideo' : 'waiting'];

  const set = async (next) => {
    setBusy(true);
    try {
      await actions.setDealScriptStatus(dealId, next);
      showMsg(next === 'received' ? 'Marked as received' : next === 'squideo' ? 'Marked as ours to write' : 'Marked as still needed');
    } catch (err) {
      showMsg(err.message || 'Could not update');
    } finally {
      setBusy(false);
    }
  };

  const download = async (fileId) => {
    try {
      const { downloadUrl } = await actions.getFileDownloadUrl(dealId, fileId);
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } catch {
      showMsg('Could not generate download link');
    }
  };

  const summary = uploaded
    ? `The client has sent ${files.length} file${files.length === 1 ? '' : 's'} through their portal.`
    : status === 'received'
      ? 'Marked as received — the portal isn’t asking the client for it.'
      : status === 'squideo'
        ? 'The client has asked us to write the script.'
        : 'Nothing received yet — their portal asks for it once their tasks are live.';

  return (
    <Card
      title={<><PenLine size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Script &amp; visual direction</>}
      count={files.length || undefined}
    >
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12,
        background: tone.bg, border: '1px solid ' + tone.border, borderRadius: 8, padding: '8px 10px',
      }}>
        {uploaded || status
          ? <Check size={14} color={tone.color} style={{ flexShrink: 0, marginTop: 2 }} />
          : <PenLine size={14} color={tone.color} style={{ flexShrink: 0, marginTop: 2 }} />}
        <div style={{ fontSize: 12.5, color: BRAND.ink, lineHeight: 1.5 }}>{summary}</div>
      </div>

      {/* The checkbox Adam asked for: "we've already got one" — usually because
          it arrived by email pre-sale. Uploads answer the step on their own, so
          it's only offered while nothing has come through the portal. */}
      {!uploaded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: BRAND.ink, cursor: busy ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              disabled={busy}
              checked={status === 'received'}
              onChange={(e) => set(e.target.checked ? 'received' : null)}
              style={{ width: 15, height: 15, flexShrink: 0 }}
            />
            We already have their script
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: BRAND.ink, cursor: busy ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              disabled={busy}
              checked={status === 'squideo'}
              onChange={(e) => set(e.target.checked ? 'squideo' : null)}
              style={{ width: 15, height: 15, flexShrink: 0 }}
            />
            We’re writing the script
          </label>
        </div>
      )}

      {files.length === 0 ? (
        <Empty text="Nothing uploaded through the portal yet." />
      ) : (
        files.map((f) => {
          const isVisual = f.category === 'visual_direction';
          const Icon = isVisual ? Palette : FileText;
          return (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + BRAND.border }}>
              <div style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 6, background: isVisual ? '#F3EFFF' : '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={14} color={isVisual ? '#7C3AED' : BRAND.muted} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</div>
                <div style={{ fontSize: 11, color: BRAND.muted }}>
                  {isVisual ? 'Visual direction' : 'Script'}
                  {f.sizeBytes ? ' · ' + fileSizeLabel(f.sizeBytes) : ''}
                  {' · '}{formatRelativeTime(f.createdAt)}
                  {f.uploadedByName ? ' · by ' + f.uploadedByName : ''}
                </div>
              </div>
              <button
                onClick={() => download(f.id)}
                title="Download"
                style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: BRAND.muted, display: 'flex' }}
              >
                <Download size={14} />
              </button>
            </div>
          );
        })
      )}

      {files.length > 0 && (
        <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 10 }}>
          Newest first — the client can send updated versions at any time.
        </div>
      )}
    </Card>
  );
}
