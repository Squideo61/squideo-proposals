import React, { useState } from 'react';
import { Eye, MousePointerClick } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { formatRelativeTime } from '../../utils.js';

// Streak-style open/click tracking UI, shared by the Gmail inbox (EmailsView)
// and the deal/project Emails section (DealDetailView). Driven by the tracking
// summary the API attaches per thread: { tracked, opens, lastOpenedAt, clicks,
// locations[], clickedUrls[] }.

// Compact indicator + hover card. Green eye once opened; faint hollow eye while
// sent-but-unopened. Renders nothing for untracked / inbound emails.
export function TrackingEye({ tracking }) {
  const [hover, setHover] = useState(false);
  if (!tracking?.tracked) return null;
  const opened = tracking.opens > 0;
  const colour = opened ? '#16A34A' : BRAND.muted;
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Eye size={14} color={colour} fill={opened ? colour + '22' : 'none'} />
      {opened && (
        <span style={{ fontSize: 10.5, fontWeight: 700, color: colour }}>
          {formatRelativeTime(tracking.lastOpenedAt).replace(' ago', '')}
        </span>
      )}
      {hover && <TrackingCard tracking={tracking} />}
    </span>
  );
}

export function TrackingCard({ tracking }) {
  const opened = tracking.opens > 0;
  return (
    <div style={{
      position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 50,
      width: 240, padding: '10px 12px', background: 'white', textAlign: 'left',
      border: '1px solid ' + BRAND.border, borderRadius: 8,
      boxShadow: '0 6px 24px rgba(0,0,0,0.14)', cursor: 'default', whiteSpace: 'normal',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12.5, color: opened ? '#16A34A' : BRAND.ink }}>
        <Eye size={14} />
        {opened ? `${tracking.opens} view${tracking.opens === 1 ? '' : 's'}` : 'Sent · not opened yet'}
      </div>
      {opened && tracking.lastOpenedAt && (
        <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 3 }}>
          Last opened {formatRelativeTime(tracking.lastOpenedAt)}
        </div>
      )}
      {opened && tracking.locations?.length > 0 && (
        <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 3 }}>
          {tracking.locations.slice(0, 3).join(', ')}
        </div>
      )}
      {tracking.clicks > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + BRAND.border }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12, color: BRAND.blue }}>
            <MousePointerClick size={13} />
            {tracking.clicks} link click{tracking.clicks === 1 ? '' : 's'}
          </div>
          {(tracking.clickedUrls || []).slice(0, 3).map((u, i) => (
            <div key={i} style={{ fontSize: 11, color: BRAND.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// Full-width summary banner, shown at the top of an opened tracked conversation.
export function TrackingBanner({ tracking }) {
  const opened = tracking.opens > 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      padding: '8px 12px', marginBottom: 14, borderRadius: 8,
      background: opened ? '#16A34A14' : BRAND.subtle || '#F3F4F6',
      border: '1px solid ' + (opened ? '#16A34A44' : BRAND.border),
      fontSize: 12.5,
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, color: opened ? '#16A34A' : BRAND.muted }}>
        <Eye size={15} />
        {opened ? `Opened ${tracking.opens}×` : 'Sent · not opened yet'}
      </span>
      {opened && tracking.lastOpenedAt && (
        <span style={{ color: BRAND.muted }}>Last opened {formatRelativeTime(tracking.lastOpenedAt)}</span>
      )}
      {opened && tracking.locations?.length > 0 && (
        <span style={{ color: BRAND.muted }}>{tracking.locations.slice(0, 3).join(', ')}</span>
      )}
      {tracking.clicks > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, color: BRAND.blue }}>
          <MousePointerClick size={14} /> {tracking.clicks} link click{tracking.clicks === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}
