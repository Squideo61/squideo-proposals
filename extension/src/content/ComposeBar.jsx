// In-compose status bar: deal picker + template dropdown.
//
// Mounted inside composeView.addStatusBar() for every compose window.
// State lives in React but the sent-event handler in content/index.jsx
// pulls the currently-selected dealId via a ref so it can attach the sent
// message to the right deal once Gmail emits the thread ID.
//
// Templates are fetched once per compose open and reused; we don't watch
// for live changes because they're rare and reloading any compose window
// picks up the fresh list anyway.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';

const BRAND = {
  ink:    '#0F2A3D',
  border: '#E5E9EE',
  muted:  '#6B7785',
  blue:   '#2BB8E6',
};
const STAGE_COLOURS = {
  lead:      { bg: '#F1F5F9', fg: '#475569' },
  qualified: { bg: '#FEF3C7', fg: '#92400E' },
  quoting:   { bg: '#DBEAFE', fg: '#1E40AF' },
  sent:      { bg: '#E0F2FE', fg: '#075985' },
  viewed:    { bg: '#CFFAFE', fg: '#0E7490' },
  signed:    { bg: '#DCFCE7', fg: '#166534' },
  paid:      { bg: '#D1FAE5', fg: '#065F46' },
  lost:      { bg: '#FEE2E2', fg: '#991B1B' },
};

// Public component: the actual React tree mounted into the status bar.
// Caller passes `controllerRef` whose `.current` will be set to an object
// exposing `getSelectedDealId()` — content/index.jsx uses this from the
// 'sent' event handler since we can't get React state out otherwise.
export function ComposeBar({
  initialDealId = null,
  initialDealTitle = null,
  initialDealStage = null,
  insertHTML,
  controllerRef,
}) {
  const [dealId, setDealId] = useState(initialDealId);
  const [dealTitle, setDealTitle] = useState(initialDealTitle);
  const [dealStage, setDealStage] = useState(initialDealStage);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  // Keep the controller pointing at the latest values so external callers
  // (the sent-event handler) always read fresh state.
  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      getSelectedDealId: () => dealId,
    };
  }, [dealId, controllerRef]);

  const pickDeal = (deal) => {
    setDealId(deal.id);
    setDealTitle(deal.title);
    setDealStage(deal.stage);
    setPickerOpen(false);
  };
  const clearDeal = () => {
    setDealId(null);
    setDealTitle(null);
    setDealStage(null);
  };

  const stageColours = STAGE_COLOURS[dealStage] || STAGE_COLOURS.lead;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 12px',
      background: '#F8FAFC', borderTop: '1px solid ' + BRAND.border,
      fontFamily: '-apple-system, system-ui, sans-serif',
      fontSize: 12, color: BRAND.ink,
      position: 'relative',
    }}>
      {/* Deal pill / picker trigger */}
      {dealId ? (
        <button
          onClick={() => setPickerOpen(o => !o)}
          title="Change linked deal"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 8px 3px 10px', borderRadius: 999,
            background: stageColours.bg, color: stageColours.fg,
            fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
            maxWidth: 240, fontFamily: 'inherit',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {dealTitle || 'Linked deal'}
          </span>
          <span
            onClick={(e) => { e.stopPropagation(); clearDeal(); }}
            role="button"
            title="Unlink"
            style={{ marginLeft: 2, opacity: 0.6, fontSize: 14, lineHeight: 1, cursor: 'pointer' }}
          >×</span>
        </button>
      ) : (
        <button
          onClick={() => setPickerOpen(o => !o)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 10px', borderRadius: 999,
            background: 'white', color: BRAND.muted,
            fontSize: 11, fontWeight: 500,
            border: '1px dashed ' + BRAND.border,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          + Link to a deal
        </button>
      )}

      <span style={{ flex: 1 }} />

      <button
        onClick={() => setTemplatesOpen(o => !o)}
        style={{
          padding: '3px 10px', borderRadius: 6,
          background: 'white', border: '1px solid ' + BRAND.border,
          fontSize: 11, fontWeight: 500, color: BRAND.ink,
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        📋 Templates
      </button>

      {pickerOpen && (
        <DealPickerPopover
          stage={dealStage}
          onPick={pickDeal}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {templatesOpen && (
        <TemplatePopover
          dealStage={dealStage}
          onPick={(template) => {
            if (template.bodyHtml) insertHTML(template.bodyHtml);
            else if (template.bodyText) insertHTML('<div>' + escapeHtml(template.bodyText).replace(/\n/g, '<br/>') + '</div>');
            setTemplatesOpen(false);
          }}
          onClose={() => setTemplatesOpen(false)}
        />
      )}
    </div>
  );
}

function DealPickerPopover({ onPick, onClose }) {
  const [deals, setDeals] = useState(null);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/api/crm/deals')
      .then(d => { if (!cancelled) setDeals(Array.isArray(d) ? d : []); })
      .catch(e => { if (!cancelled) setErr(e?.message || 'Failed to load'); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!deals) return [];
    const q = query.trim().toLowerCase();
    return deals
      .filter(d => d.stage !== 'lost')
      .filter(d => !q || (d.title || '').toLowerCase().includes(q))
      .slice(0, 10);
  }, [deals, query]);

  return (
    <Popover onClose={onClose}>
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search deals…"
        style={popoverInput}
      />
      {!deals && <div style={popoverMuted}>Loading…</div>}
      {err && <div style={{ ...popoverMuted, color: '#DC2626' }}>{err}</div>}
      {deals && filtered.length === 0 && <div style={popoverMuted}>No matching deals.</div>}
      {filtered.map(d => {
        const c = STAGE_COLOURS[d.stage] || STAGE_COLOURS.lead;
        return (
          <button
            key={d.id}
            onClick={() => onPick(d)}
            style={popoverRow}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
            <span style={{
              padding: '1px 6px', borderRadius: 3,
              background: c.bg, color: c.fg,
              fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: 0.4,
            }}>{d.stage}</span>
          </button>
        );
      })}
    </Popover>
  );
}

function TemplatePopover({ dealStage, onPick, onClose }) {
  const [templates, setTemplates] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const path = dealStage
      ? '/api/crm/templates?stage=' + encodeURIComponent(dealStage)
      : '/api/crm/templates';
    api.get(path)
      .then(t => { if (!cancelled) setTemplates(Array.isArray(t) ? t : []); })
      .catch(e => { if (!cancelled) setErr(e?.message || 'Failed to load'); });
    return () => { cancelled = true; };
  }, [dealStage]);

  return (
    <Popover onClose={onClose} right>
      {!templates && <div style={popoverMuted}>Loading templates…</div>}
      {err && <div style={{ ...popoverMuted, color: '#DC2626' }}>{err}</div>}
      {templates && templates.length === 0 && (
        <div style={popoverMuted}>
          No templates yet. Create one in the Squideo web app (Templates section).
        </div>
      )}
      {templates && templates.map(t => (
        <button
          key={t.id}
          onClick={() => onPick(t)}
          style={popoverRow}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
            {t.name}
          </span>
          {t.stage && (
            <span style={{ fontSize: 10, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{t.stage}</span>
          )}
        </button>
      ))}
    </Popover>
  );
}

function Popover({ children, onClose, right }) {
  // Click-outside-to-close. Implemented at component level so we don't
  // need a separate listener registration in Gmail's DOM (which is
  // virtualised and re-renders aggressively).
  const ref = useRef(null);
  useEffect(() => {
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 4px)',
        ...(right ? { right: 12 } : { left: 12 }),
        background: 'white', border: '1px solid ' + BRAND.border,
        borderRadius: 8, boxShadow: '0 4px 16px rgba(15,42,61,0.12)',
        padding: 8, minWidth: 260, maxWidth: 340,
        maxHeight: 320, overflowY: 'auto',
        zIndex: 99999,
      }}
    >
      {children}
    </div>
  );
}

const popoverInput = {
  width: '100%', padding: '6px 8px', marginBottom: 6,
  border: '1px solid ' + BRAND.border, borderRadius: 6,
  fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
};
const popoverMuted = {
  padding: '8px 10px', fontSize: 12, color: BRAND.muted,
};
const popoverRow = {
  display: 'flex', alignItems: 'center', gap: 6,
  width: '100%', padding: '6px 8px',
  background: 'white', border: 'none', borderRadius: 6,
  fontSize: 12, color: BRAND.ink, cursor: 'pointer',
  textAlign: 'left', fontFamily: 'inherit',
  marginTop: 2,
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
