import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { STAGE_COLOURS, STAGE_LABEL } from '../../lib/stages.js';

function StagePill({ stage }) {
  const c = STAGE_COLOURS[stage] || STAGE_COLOURS.lead;
  return (
    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: c.bg, color: c.fg, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {STAGE_LABEL[stage] || stage}
    </span>
  );
}

// Search-and-suggest deal picker. Replaces the <select> listing every deal,
// which stopped being usable once there were more than a screenful — the same
// interaction the email side panel's AttachPicker uses, in a form the modals
// can drop in.
//
// Matches on the deal title AND its company name, most recently active first,
// capped at `limit` (you're meant to type, not scroll). ↑/↓ move the highlight,
// Enter takes it. When `onCreate` is given, a create row sits under the results
// so a deal that doesn't exist yet can be made from what you typed without
// leaving the modal.
export function DealSearchPicker({
  excludeIds = [],
  excludeStages = ['lost'],
  onPick,
  onCreate = null,
  defaultCreateTitle = '',
  busy = false,
  limit = 8,
  autoFocus = true,
  placeholder,
}) {
  const { state, actions } = useStore();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef(null);

  // A deal page reached by deep link may never have loaded the pipeline, which
  // is where state.deals is filled — without this the picker would sit there
  // claiming there are no deals to move the email to.
  useEffect(() => {
    if (!state.deals || Object.keys(state.deals).length === 0) actions.refreshDeals?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim();
  const excludeKey = excludeIds.join(',');
  const stageKey = excludeStages.join(',');

  const companyName = (d) => (d.companyId && state.companies?.[d.companyId]?.name) || '';

  const matches = useMemo(() => {
    const needle = q.toLowerCase();
    const exclude = new Set(excludeIds);
    const skipStage = new Set(excludeStages);
    return Object.values(state.deals || {})
      .filter((d) => d && d.id && !exclude.has(d.id) && !skipStage.has(d.stage))
      .filter((d) => !needle || `${d.title || ''} ${companyName(d)}`.toLowerCase().includes(needle))
      .sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0))
      .slice(0, limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.deals, state.companies, q, excludeKey, stageKey, limit]);

  useEffect(() => { setHighlight(0); }, [q]);

  // The name a new deal would take: what's been typed, else the caller's
  // suggestion (an email subject, say). Hidden when a deal of that name already
  // exists — that's the one to pick, not a second copy of it.
  const createTitle = q || defaultCreateTitle.trim();
  const exactExists = useMemo(
    () => !!createTitle && Object.values(state.deals || {}).some((d) => d && (d.title || '').toLowerCase() === createTitle.toLowerCase()),
    [state.deals, createTitle]
  );
  const canCreate = !!onCreate && !!createTitle && !exactExists;

  // The create row is the last stop after the results, so ↓ reaches it too.
  const rowCount = matches.length + (canCreate ? 1 : 0);
  const onCreateRow = canCreate && highlight === matches.length;

  const take = (i) => {
    if (busy) return;
    if (canCreate && i === matches.length) onCreate(createTitle);
    else if (matches[i]) onPick(matches[i]);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rowCount) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => (h + step + rowCount) % rowCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      take(highlight);
    }
  };

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
        <input
          className="input"
          autoFocus={autoFocus}
          value={query}
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder || (onCreate ? 'Search deals, or type a new deal name…' : 'Search deals…')}
          style={{ paddingLeft: 32 }}
        />
      </div>
      <div
        ref={listRef}
        style={{ marginTop: 8, border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden', opacity: busy ? 0.6 : 1 }}
      >
        {matches.map((d, i) => {
          const co = companyName(d);
          const on = highlight === i;
          return (
            <button
              key={d.id}
              type="button"
              disabled={busy}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => take(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                padding: '9px 12px', background: on ? '#F1F9FE' : 'white', border: 'none',
                borderTop: i === 0 ? 'none' : '1px solid ' + BRAND.border,
                cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.title || '(untitled deal)'}
                {co && <span style={{ color: BRAND.muted, fontWeight: 400 }}> · {co}</span>}
              </span>
              {d.stage && <StagePill stage={d.stage} />}
            </button>
          );
        })}
        {canCreate && (
          <button
            type="button"
            disabled={busy}
            onMouseEnter={() => setHighlight(matches.length)}
            onClick={() => take(matches.length)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              padding: '9px 12px', background: onCreateRow ? '#F1F9FE' : BRAND.paper, border: 'none',
              borderTop: matches.length ? '1px solid ' + BRAND.border : 'none',
              cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13.5, color: BRAND.ink,
            }}
          >
            <Plus size={14} color={BRAND.blue} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Create new deal “<strong>{createTitle}</strong>”
            </span>
          </button>
        )}
        {rowCount === 0 && (
          <div style={{ padding: 14, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
            {Object.keys(state.deals || {}).length === 0
              ? 'Loading deals…'
              : q ? 'No deals match your search.' : 'No other deals yet.'}
          </div>
        )}
      </div>
      {!q && matches.length >= limit && (
        <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 6 }}>
          Showing the {limit} most recently active — type to search the rest.
        </div>
      )}
    </div>
  );
}
