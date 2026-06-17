import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Eye, MousePointerClick, ChevronRight } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { formatRelativeTime } from '../../utils.js';

const CARD_WIDTH = 240;

// Streak-style open/click tracking UI, shared by the Gmail inbox (EmailsView)
// and the deal/project Emails section (DealDetailView). Driven by the tracking
// summary the API attaches per thread: { tracked, opens, lastOpenedAt, clicks,
// locations[], clickedUrls[] }.

// Compact indicator + hover card. Green eye once opened; faint hollow eye while
// sent-but-unopened. Renders nothing for untracked / inbound emails.
//
// The hover card is rendered in a portal with fixed positioning (anchored to the
// eye) so it floats above the page and is never clipped by an `overflow:hidden`
// ancestor (e.g. the deal Emails row). A short close delay bridges the gap so
// you can move the mouse onto the card to read it.
export function TrackingEye({ tracking }) {
  const [pos, setPos] = useState(null);
  const anchorRef = useRef(null);
  const closeTimer = useRef(null);

  if (!tracking?.tracked) return null;
  const opened = tracking.opens > 0;
  const colour = opened ? '#16A34A' : BRAND.muted;

  const open = () => {
    clearTimeout(closeTimer.current);
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Right-align the card to the eye, then clamp inside the viewport.
    const left = Math.min(Math.max(8, r.right - CARD_WIDTH), window.innerWidth - CARD_WIDTH - 8);
    // Prefer below the eye; flip above if there isn't room.
    const estHeight = 150;
    const top = (r.bottom + 6 + estHeight > window.innerHeight)
      ? Math.max(8, r.top - 6 - estHeight)
      : r.bottom + 6;
    setPos({ left, top });
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPos(null), 120);
  };

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <Eye size={14} color={colour} fill={opened ? colour + '22' : 'none'} />
      {opened && (
        <span style={{ fontSize: 10.5, fontWeight: 700, color: colour }}>
          {formatRelativeTime(tracking.lastOpenedAt).replace(' ago', '')}
        </span>
      )}
      {pos && createPortal(
        <TrackingCard
          tracking={tracking}
          style={{ position: 'fixed', left: pos.left, top: pos.top, right: 'auto', marginTop: 0, zIndex: 3000 }}
          onMouseEnter={() => clearTimeout(closeTimer.current)}
          onMouseLeave={scheduleClose}
        />,
        document.body,
      )}
    </span>
  );
}

export function TrackingCard({ tracking, style, onMouseEnter, onMouseLeave }) {
  const opened = tracking.opens > 0;
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 50,
        width: CARD_WIDTH, padding: '10px 12px', background: 'white', textAlign: 'left',
        border: '1px solid ' + BRAND.border, borderRadius: 8,
        boxShadow: '0 6px 24px rgba(0,0,0,0.14)', cursor: 'default', whiteSpace: 'normal',
        ...style,
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

// Compact summary "pill", shown at the top of an opened tracked conversation.
// Sizes to its content (doesn't span the row) and, when `onClick` is supplied,
// becomes a button that opens the full email-tracking view.
export function TrackingBanner({ tracking, onClick }) {
  const opened = tracking.opens > 0;
  const clickable = typeof onClick === 'function';
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      title={clickable ? 'View full tracking details' : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        maxWidth: '100%', padding: '8px 12px', marginBottom: 14, borderRadius: 8,
        background: opened ? '#16A34A14' : BRAND.subtle || '#F3F4F6',
        border: '1px solid ' + (opened ? '#16A34A44' : BRAND.border),
        fontSize: 12.5, cursor: clickable ? 'pointer' : 'default',
      }}
    >
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
      {clickable && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontWeight: 600, color: opened ? '#16A34A' : BRAND.muted }}>
          Details <ChevronRight size={14} />
        </span>
      )}
    </div>
  );
}
