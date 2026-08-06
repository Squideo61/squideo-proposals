import React, { useEffect, useMemo, useState } from 'react';
import { Mail, Search, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

// The contact's organisation name, from either shape of the company link
// (contacts carry companyIds when they sit on several).
function contactCompanyName(state, c) {
  const ids = (c?.companyIds && c.companyIds.length) ? c.companyIds : (c?.companyId ? [c.companyId] : []);
  for (const id of ids) {
    const n = state.companies?.[id]?.name;
    if (n) return n;
  }
  return '';
}

// Everyone in the CRM keyed by lowercased email — how an address on a thread
// gets matched back to a contact record.
function useContactsByEmail() {
  const { state } = useStore();
  return useMemo(() => {
    const m = new Map();
    for (const c of Object.values(state.contacts || {})) {
      if (c?.email) m.set(c.email.toLowerCase(), c);
    }
    return m;
  }, [state.contacts]);
}

// Resolve the first of `emails` that belongs to a known contact. Exported so a
// form can preselect before this picker ever renders.
export function useSuggestedContact(emails) {
  const byEmail = useContactsByEmail();
  const key = (emails || []).join(',').toLowerCase();
  return useMemo(() => {
    for (const e of emails || []) {
      const hit = byEmail.get(String(e || '').trim().toLowerCase());
      if (hit) return hit;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byEmail, key]);
}

// Search-and-suggest contact picker, in place of a select listing every contact
// in the CRM. Matches on name, email, job title and company.
//
// `suggestEmails` are addresses from whatever the form is about — the people on
// an email thread, say. Any that match a contact are offered first, before
// anything has been typed, so the obvious answer is one click away instead of
// somewhere in an alphabetical list of hundreds.
export function ContactSearchPicker({
  value = '',
  onChange,
  suggestEmails = [],
  limit = 8,
  autoFocus = false,
  placeholder = 'Search by name, email or company…',
}) {
  const { state } = useStore();
  const byEmail = useContactsByEmail();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const selected = value ? state.contacts?.[value] : null;
  const q = query.trim().toLowerCase();
  const suggestKey = (suggestEmails || []).join(',').toLowerCase();

  // Contacts on this email/thread that the CRM already knows, deduped and in
  // the order they were given (the counterparty of the latest message first).
  const suggested = useMemo(() => {
    const out = [];
    const seen = new Set();
    for (const e of suggestEmails || []) {
      const hit = byEmail.get(String(e || '').trim().toLowerCase());
      if (hit && !seen.has(hit.id)) { seen.add(hit.id); out.push(hit); }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byEmail, suggestKey]);

  const matches = useMemo(() => {
    const all = Object.values(state.contacts || {});
    if (!q) {
      // Nothing typed: lead with the thread's own people, then fill with the
      // rest alphabetically so the list is never just empty.
      const ids = new Set(suggested.map((c) => c.id));
      const rest = all
        .filter((c) => c && !ids.has(c.id))
        .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));
      return [...suggested, ...rest].slice(0, limit);
    }
    return all
      .filter((c) => c && [c.name, c.email, c.title, contactCompanyName(state, c)].filter(Boolean).join(' ').toLowerCase().includes(q))
      .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''))
      .slice(0, limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.contacts, state.companies, q, suggested, limit]);

  useEffect(() => { setHighlight(0); }, [q]);

  // Something is selected but its record hasn't loaded yet. Showing the empty
  // search box here would read as "no contact" when the form is in fact holding
  // one, so say so and still allow a change.
  if (value && !selected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: BRAND.paper, marginTop: 4 }}>
        <span style={{ flex: 1, fontSize: 13, color: BRAND.muted }}>Contact selected — loading…</span>
        <button type="button" className="btn-icon" aria-label="Clear contact" onClick={() => onChange('')}><X size={14} /></button>
      </div>
    );
  }

  // Picked already: show who, with a way back to the search.
  if (selected) {
    const co = contactCompanyName(state, selected);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: BRAND.paper, marginTop: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected.name || selected.email}
            {co && <span style={{ color: BRAND.muted, fontWeight: 400 }}> · {co}</span>}
          </div>
          {selected.email && selected.name && (
            <div style={{ fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.email}</div>
          )}
        </div>
        <button
          type="button"
          className="btn-icon"
          aria-label="Clear contact"
          title="Choose someone else"
          onClick={() => { setQuery(''); onChange(''); }}
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  const take = (i) => { if (matches[i]) onChange(matches[i].id); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!matches.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => (h + step + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      take(highlight);
    }
  };

  const suggestedIds = new Set(suggested.map((c) => c.id));

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
          style={{ paddingLeft: 32 }}
        />
      </div>
      <div style={{ marginTop: 6, border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
        {matches.map((c, i) => {
          const co = contactCompanyName(state, c);
          const on = highlight === i;
          const fromEmail = !q && suggestedIds.has(c.id);
          return (
            <button
              key={c.id}
              type="button"
              onMouseEnter={() => setHighlight(i)}
              onClick={() => take(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                padding: '8px 12px', background: on ? '#F1F9FE' : 'white', border: 'none',
                borderTop: i === 0 ? 'none' : '1px solid ' + BRAND.border,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 500, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name || c.email}
                  {co && <span style={{ color: BRAND.muted, fontWeight: 400 }}> · {co}</span>}
                </span>
                {c.email && c.name && (
                  <span style={{ display: 'block', fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email}</span>
                )}
              </span>
              {fromEmail && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: '#1B5896', background: '#E6F0FB', padding: '2px 7px', borderRadius: 999 }}>
                  <Mail size={10} /> ON THIS EMAIL
                </span>
              )}
            </button>
          );
        })}
        {matches.length === 0 && (
          <div style={{ padding: 12, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
            {Object.keys(state.contacts || {}).length === 0 ? 'No contacts yet.' : 'No contacts match your search.'}
          </div>
        )}
      </div>
    </div>
  );
}
