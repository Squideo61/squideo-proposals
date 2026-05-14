// Reusable typeahead over the local mirror of Xero contacts. The picker
// returns the full Xero contact row to the parent — the parent decides what
// to persist (e.g. resolve into a local `companies` row, or attach the
// xero_contact_id to a proposal).

import React, { useEffect, useRef, useState } from 'react';
import { Search, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';

export function XeroContactPicker({
  value,            // selected Xero contact object, or null
  onChange,         // (contact | null) => void
  placeholder = 'Search Xero contacts…',
  autoFocus = false,
  size = 'md',      // 'sm' | 'md'
  allowClear = true,
}) {
  const { showMsg } = useStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const containerRef = useRef(null);

  // Close dropdown on outside click.
  useEffect(() => {
    function onDocClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      api.get(`/api/crm/xero-contacts/search?q=${encodeURIComponent(q)}&includeArchived=1`)
        .then((rows) => {
          setResults(rows || []);
          setActiveIdx(rows && rows.length ? 0 : -1);
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(t);
  }, [query, open]);

  async function handleSync() {
    setSyncing(true);
    try {
      const r = await api.post('/api/crm/xero-contacts/sync');
      showMsg?.(`Synced ${r.upserts} Xero contacts`, 'success');
      // Re-run the current query.
      if (query.trim()) {
        const rows = await api.get(`/api/crm/xero-contacts/search?q=${encodeURIComponent(query.trim())}&includeArchived=1`);
        setResults(rows || []);
      }
    } catch (err) {
      showMsg?.(err.message || 'Sync failed (admin only)', 'error');
    } finally {
      setSyncing(false);
    }
  }

  function handlePick(c) {
    onChange?.(c);
    setQuery('');
    setOpen(false);
  }

  function handleKey(e) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      handlePick(results[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const inputHeight = size === 'sm' ? 30 : 36;

  // When a contact is selected, render the chip view with a "change" affordance.
  if (value && !open) {
    return (
      <div ref={containerRef} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: inputHeight,
          padding: '6px 10px',
          background: '#F0FDF4',
          border: '1px solid #BBF7D0',
          borderRadius: 6,
        }}>
          <Check size={14} color="#16A34A" style={{ flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {value.name}
            </div>
            {value.email && (
              <div style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {value.email}
              </div>
            )}
          </div>
          {value.status === 'ARCHIVED' && (
            <span style={{ fontSize: 10, color: '#B45309', background: '#FEF3C7', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>
              ARCHIVED
            </span>
          )}
          <button type="button" onClick={() => setOpen(true)} className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}>
            Change
          </button>
          {allowClear && (
            <button type="button" onClick={() => onChange?.(null)} className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11, color: BRAND.muted }}>
              Clear
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          type="text"
          className="input"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={{ paddingLeft: 30, height: inputHeight }}
        />
      </div>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: 4,
          background: 'white',
          border: '1px solid ' + BRAND.border,
          borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          zIndex: 50,
          maxHeight: 320,
          overflow: 'auto',
        }}>
          {loading && (
            <div style={{ padding: 12, fontSize: 12, color: BRAND.muted, textAlign: 'center' }}>
              Searching…
            </div>
          )}

          {!loading && query.trim() && results.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: BRAND.muted, textAlign: 'center' }}>
              No matches. Try refreshing from Xero or use a different name.
            </div>
          )}

          {!loading && !query.trim() && (
            <div style={{ padding: 12, fontSize: 12, color: BRAND.muted, textAlign: 'center' }}>
              Type to search Xero contacts.
            </div>
          )}

          {results.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onClick={() => handlePick(c)}
              onMouseEnter={() => setActiveIdx(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '8px 12px',
                background: i === activeIdx ? '#F1F5F9' : 'white',
                border: 'none',
                borderBottom: '1px solid ' + BRAND.border,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.name}
                </div>
                <div style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.email || '—'}
                  {c.defaultCurrency && c.defaultCurrency !== 'GBP' && ` · ${c.defaultCurrency}`}
                  {c.country && c.country !== 'United Kingdom' && ` · ${c.country}`}
                </div>
              </div>
              {c.status === 'ARCHIVED' && (
                <span style={{ fontSize: 10, color: '#B45309', background: '#FEF3C7', padding: '2px 6px', borderRadius: 4, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <AlertTriangle size={10} />
                  ARCHIVED
                </span>
              )}
            </button>
          ))}

          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              width: '100%',
              padding: '8px 12px',
              background: BRAND.paper,
              border: 'none',
              cursor: syncing ? 'wait' : 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              color: BRAND.muted,
              fontWeight: 500,
            }}
          >
            <RefreshCw size={12} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
            {syncing ? 'Refreshing…' : 'Refresh from Xero'}
          </button>
        </div>
      )}
    </div>
  );
}
