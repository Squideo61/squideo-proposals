import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Briefcase, Building2, User, FileText, CornerDownLeft } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatProposalNumber } from '../../utils.js';

// CRM-wide search in the top bar: type to find deals, companies, contacts and
// proposals across the whole workspace, then jump straight to one. Results are
// matched client-side from the store (which the CRM shell already keeps loaded),
// grouped by type, keyboard-navigable, and openable with Enter or a click.
// Cmd/Ctrl+K focuses it from anywhere.
const GROUPS = [
  { type: 'deal', label: 'Deals', icon: Briefcase },
  { type: 'company', label: 'Companies', icon: Building2 },
  { type: 'contact', label: 'Contacts', icon: User },
  { type: 'proposal', label: 'Proposals', icon: FileText },
];
const PER_GROUP = 6;

// 2 = a field starts with the query (stronger), 1 = contains it, 0 = no match.
function scoreFields(fields, q) {
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const s = String(f).toLowerCase();
    if (s.startsWith(q)) return 2;
    if (s.includes(q)) best = 1;
  }
  return best;
}

// `hideTrigger` + `openSignal` let a parent (the mobile header burger menu) own
// the launch button and pop the search overlay itself: bumping `openSignal`
// opens the mobile overlay, and the component renders overlay-only (no magnifier
// button of its own).
export function GlobalSearch({ navigate, isMobile, hideTrigger = false, openSignal = 0 }) {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false); // mobile overlay
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const companies = state.companies || {};
    const contacts = state.contacts || {};

    const deals = Object.values(state.deals || {})
      .filter(Boolean)
      .map((d) => {
        const company = d.companyId ? companies[d.companyId] : null;
        const contact = d.primaryContactId ? contacts[d.primaryContactId] : null;
        // Reference included so "2607-014" jumps straight to the deal — the
        // point of a quotable number is being able to look it up.
        const score = scoreFields([d.title, d.reference, company?.name, contact?.name, contact?.email], q);
        return score ? { score, recency: new Date(d.lastActivityAt || 0).getTime(), item: d, company } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.recency - a.recency)
      .slice(0, PER_GROUP)
      .map(({ item, company }) => ({
        type: 'deal', id: item.id, icon: Briefcase,
        title: item.title || 'Untitled deal',
        subtitle: [item.reference, company?.name].filter(Boolean).join(' · ') || null,
        go: () => navigate('deal', item.id),
      }));

    const companyList = Object.values(companies)
      .filter(Boolean)
      .map((c) => ({ score: scoreFields([c.name, c.website], q), item: c }))
      .filter((x) => x.score)
      .sort((a, b) => b.score - a.score || (a.item.name || '').localeCompare(b.item.name || ''))
      .slice(0, PER_GROUP)
      .map(({ item }) => ({
        type: 'company', id: item.id, icon: Building2,
        title: item.name || 'Unnamed company',
        subtitle: item.website || null,
        go: () => navigate('company', item.id),
      }));

    const contactList = Object.values(contacts)
      .filter(Boolean)
      .map((c) => {
        const company = c.companyId ? companies[c.companyId] : null;
        return { score: scoreFields([c.name, c.email, company?.name], q), item: c, company };
      })
      .filter((x) => x.score)
      .sort((a, b) => b.score - a.score || (a.item.name || a.item.email || '').localeCompare(b.item.name || b.item.email || ''))
      .slice(0, PER_GROUP)
      .map(({ item, company }) => ({
        type: 'contact', id: item.id, icon: User,
        title: item.name || item.email || 'Unnamed contact',
        subtitle: [item.name ? item.email : null, company?.name].filter(Boolean).join(' · ') || null,
        go: () => navigate('contact', item.id),
      }));

    const proposalList = Object.values(state.proposals || {})
      .filter(Boolean)
      .map((p) => {
        const number = p._number ? formatProposalNumber(p._number) : '';
        return { score: scoreFields([p.clientName, p.contactBusinessName, number], q), item: p, number };
      })
      .filter((x) => x.score)
      .sort((a, b) => b.score - a.score)
      .slice(0, PER_GROUP)
      .map(({ item, number }) => ({
        type: 'proposal', id: item.id, icon: FileText,
        title: item.clientName || 'Untitled proposal',
        subtitle: [number, item.contactBusinessName].filter(Boolean).join(' · ') || null,
        go: () => navigate('builder', item.id),
      }));

    const byType = { deal: deals, company: companyList, contact: contactList, proposal: proposalList };
    // Flatten in group order, tagging the first row of each group so we can draw
    // a header above it. activeIndex walks this flat list.
    const flat = [];
    for (const g of GROUPS) {
      const rows = byType[g.type] || [];
      rows.forEach((r, i) => flat.push({ ...r, groupLabel: i === 0 ? g.label : null }));
    }
    return flat;
  }, [query, state.deals, state.companies, state.contacts, state.proposals, navigate]);

  useEffect(() => { setActive(0); }, [query]);

  // Cmd/Ctrl+K focuses search from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (isMobile) setMobileOpen(true);
        else { setOpen(true); inputRef.current?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isMobile]);

  // Close on outside click (desktop).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Focus the input when the mobile overlay opens.
  useEffect(() => { if (mobileOpen) setTimeout(() => inputRef.current?.focus(), 30); }, [mobileOpen]);

  // Parent-driven open (mobile header burger). Ignore the initial 0.
  useEffect(() => { if (openSignal) setMobileOpen(true); }, [openSignal]);

  const choose = (r) => {
    if (!r) return;
    r.go();
    setQuery('');
    setOpen(false);
    setMobileOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') { setOpen(false); setMobileOpen(false); inputRef.current?.blur(); }
  };

  const showDropdown = (open || mobileOpen) && query.trim().length >= 2;

  const resultsList = (
    <div role="listbox" style={{ maxHeight: isMobile ? '70vh' : 420, overflowY: 'auto', padding: 4 }}>
      {results.length === 0 ? (
        <div style={{ padding: '14px 12px', fontSize: 13, color: BRAND.muted, textAlign: 'center' }}>
          No matches for “{query.trim()}”.
        </div>
      ) : results.map((r, i) => (
        <React.Fragment key={r.type + r.id}>
          {r.groupLabel && (
            <div style={{ fontSize: 10.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 10px 3px' }}>{r.groupLabel}</div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(r)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
              padding: '8px 10px', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              background: i === active ? BRAND.paper : 'transparent',
            }}
          >
            <r.icon size={15} color={BRAND.muted} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
              {r.subtitle && <span style={{ display: 'block', fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subtitle}</span>}
            </span>
            {i === active && <CornerDownLeft size={13} color={BRAND.muted} style={{ flexShrink: 0 }} />}
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  // ---- Mobile: a magnifier that opens a full-width overlay ----
  if (isMobile) {
    return (
      <>
        {!hideTrigger && (
          <button type="button" onClick={() => setMobileOpen(true)} className="btn-icon" title="Search" aria-label="Search">
            <Search size={18} />
          </button>
        )}
        {mobileOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,42,61,0.35)' }} onClick={() => setMobileOpen(false)}>
            {/* paddingTop carries the iOS safe-area inset so the input + close
                button clear the status bar / notch (otherwise they sit under it,
                obscured and untappable). */}
            <div onClick={(e) => e.stopPropagation()} style={{ background: 'white', padding: 10, paddingTop: 'calc(10px + env(safe-area-inset-top))', boxShadow: '0 8px 24px rgba(15,42,61,0.18)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <Search size={16} color={BRAND.muted} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
                  <input
                    ref={inputRef}
                    className="input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search deals, companies, contacts…"
                    style={{ paddingLeft: 36, paddingRight: query ? 32 : 12, width: '100%', boxSizing: 'border-box' }}
                  />
                  {query && (
                    <button type="button" onClick={() => { setQuery(''); inputRef.current?.focus(); }} aria-label="Clear search" style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: BRAND.muted }}>
                      <X size={14} />
                    </button>
                  )}
                </div>
                {/* A dedicated Cancel button: a clear, always-visible tap target
                    to close the overlay (the input's ✕ only clears the text). */}
                <button type="button" onClick={() => setMobileOpen(false)} className="btn-ghost" style={{ flexShrink: 0, padding: '8px 12px' }}>
                  Cancel
                </button>
              </div>
              {showDropdown && <div style={{ marginTop: 8, border: '1px solid ' + BRAND.border, borderRadius: 10 }}>{resultsList}</div>}
            </div>
          </div>
        )}
      </>
    );
  }

  // ---- Desktop: inline search box with a dropdown ----
  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', maxWidth: 420 }}>
      <Search size={15} color={BRAND.muted} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
      <input
        ref={inputRef}
        className="input"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search deals, companies, contacts…"
        style={{ paddingLeft: 36, paddingRight: query ? 32 : 12, height: 38, width: '100%' }}
      />
      {query && (
        <button type="button" onClick={() => { setQuery(''); inputRef.current?.focus(); }} aria-label="Clear search" style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: BRAND.muted }}>
          <X size={14} />
        </button>
      )}
      {showDropdown && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, boxShadow: '0 8px 24px rgba(15,42,61,0.12)', zIndex: 60 }}>
          {resultsList}
        </div>
      )}
    </div>
  );
}
