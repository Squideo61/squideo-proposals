import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Plus, Search, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

// Search-and-suggest organisation picker, in place of a <select> listing every
// company in the CRM — unusable once there are hundreds, and it can only offer
// what already exists. Matches on name, and on the Xero/Companies House-ish
// extras a company row carries (domain, city, postcode) so "the one in Leeds"
// is findable.
//
// Typing a name that doesn't exist offers to CREATE it, right here: linking a
// deal or a contact to a brand-new client shouldn't mean abandoning the form
// and going to Contacts → Organisations first. The new company lands in the
// store, so every other picker on screen has it immediately.
//
// Mirrors ContactSearchPicker's shape (inline list, keyboard nav, a clearable
// selection) so the two read as one control in the same form.
export function CompanySearchPicker({
  value = '',
  onChange,
  limit = 8,
  autoFocus = false,
  allowCreate = true,
  placeholder = 'Search organisations…',
  emptyLabel = 'No organisation',
}) {
  const { state, actions } = useStore();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const selected = value ? state.companies?.[value] : null;
  const typed = query.trim();
  const q = typed.toLowerCase();

  const matches = useMemo(() => {
    const all = Object.values(state.companies || {}).filter((c) => c && c.name);
    const sorted = (list) => list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!q) return sorted(all).slice(0, limit);
    return sorted(all.filter((c) =>
      [c.name, c.domain, c.address?.city, c.address?.postcode].filter(Boolean).join(' ').toLowerCase().includes(q)
    )).slice(0, limit);
  }, [state.companies, q, limit]);

  // Offer to create only when the typed name isn't already one of the matches —
  // otherwise the obvious action would be "create a duplicate".
  const exact = matches.some((c) => (c.name || '').trim().toLowerCase() === q);
  const canCreate = allowCreate && !!typed && !exact;

  useEffect(() => { setHighlight(0); setError(''); }, [q]);

  const create = async () => {
    if (!typed || creating) return;
    setCreating(true);
    setError('');
    try {
      const co = await actions.createCompany({ name: typed });
      if (!co?.id) throw new Error('Could not create that organisation');
      setQuery('');
      onChange(co.id);
    } catch (err) {
      setError(err?.message || 'Could not create that organisation');
    } finally {
      setCreating(false);
    }
  };

  // Selected but the record hasn't loaded yet — say so rather than showing an
  // empty search box, which would read as "no organisation" when one is set.
  if (value && !selected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: BRAND.paper, marginTop: 4 }}>
        <span style={{ flex: 1, fontSize: 13, color: BRAND.muted }}>Organisation selected — loading…</span>
        <button type="button" className="btn-icon" aria-label="Clear organisation" onClick={() => onChange('')}><X size={14} /></button>
      </div>
    );
  }

  if (selected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: BRAND.paper, marginTop: 4 }}>
        <Building2 size={14} color={BRAND.muted} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected.name}
        </div>
        <button
          type="button"
          className="btn-icon"
          aria-label="Clear organisation"
          title="Choose a different organisation"
          onClick={() => { setQuery(''); onChange(''); }}
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  // Rows are the matches, then the create row (when offered) — one index space,
  // so the keyboard walks straight from the last match onto "Create …".
  const rowCount = matches.length + (canCreate ? 1 : 0);
  const take = (i) => {
    if (i < matches.length) onChange(matches[i].id);
    else if (canCreate) create();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rowCount) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => (h + step + rowCount) % rowCount);
    } else if (e.key === 'Enter') {
      // Never let Enter submit the form the picker sits in — in the deal editor
      // that would save the deal instead of choosing the organisation.
      e.preventDefault();
      take(highlight);
    }
  };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ position: 'relative' }}>
        <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
        <input
          className="input"
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          name="squideo-organisation"
          autoComplete="off"
          style={{ paddingLeft: 32 }}
        />
      </div>
      {error && <div style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{error}</div>}
      <div style={{ marginTop: 6, border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
        {matches.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onMouseEnter={() => setHighlight(i)}
            onClick={() => take(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              padding: '8px 12px', background: highlight === i ? '#F1F9FE' : 'white', border: 'none',
              borderTop: i === 0 ? 'none' : '1px solid ' + BRAND.border,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 500, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.name}
            </span>
            {c.address?.city && <span style={{ flexShrink: 0, fontSize: 11.5, color: BRAND.muted }}>{c.address.city}</span>}
          </button>
        ))}
        {canCreate && (
          <button
            type="button"
            onMouseEnter={() => setHighlight(matches.length)}
            onClick={create}
            disabled={creating}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              padding: '8px 12px', background: highlight === matches.length ? '#F1F9FE' : 'white', border: 'none',
              borderTop: matches.length ? '1px solid ' + BRAND.border : 'none',
              cursor: creating ? 'default' : 'pointer', fontFamily: 'inherit',
            }}
          >
            <Plus size={14} color="#0B6E93" style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: '#0B6E93', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {creating ? `Creating “${typed}”…` : `Create “${typed}”`}
            </span>
          </button>
        )}
        {rowCount === 0 && (
          <div style={{ padding: 12, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
            {Object.keys(state.companies || {}).length === 0
              ? 'No organisations yet — type a name to create one.'
              : 'No organisations match your search.'}
          </div>
        )}
      </div>
      {!value && (
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>{emptyLabel}</div>
      )}
    </div>
  );
}
