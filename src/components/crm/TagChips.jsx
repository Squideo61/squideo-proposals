// Tag filter chips for the Contacts list, and the small picker used to apply
// tags to a single contact.
//
// Filtering is entirely client-side: the store already holds every contact, so
// intersecting a Set of ids is instant and composes for free with the existing
// search box and "Customers only" toggle. That combination is the point —
// "course signups who became customers" is two clicks, no new endpoint.

import React, { useMemo, useState } from 'react';
import { Tag as TagIcon, X, Plus, Check } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

// A tag's colour is used at 12% for the chip fill so a saturated brand colour
// doesn't fight the text sitting on it.
const tint = (hex, alpha = '1F') => hex + alpha;

export function TagChip({ tag, small = false, onRemove }) {
  if (!tag) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: small ? 10.5 : 11.5, fontWeight: 700,
      padding: small ? '1px 6px' : '2px 8px', borderRadius: 999,
      background: tint(tag.colour), border: `1px solid ${tag.colour}`, color: '#3B4A55',
      whiteSpace: 'nowrap',
    }}>
      {tag.label}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title={`Remove "${tag.label}"`}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', color: '#3B4A55' }}
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}

// The filter row. `selected` is a Set of tag ids; `mode` is 'any' | 'all'.
export function TagChips({ contacts, selected, onToggle, mode, onModeChange, onClear }) {
  const { state } = useStore();
  const tags = state.tags || [];

  // Counts come from the contacts currently in view, not from the tag's global
  // count — a chip reading "12" next to a list of 3 is just confusing.
  const counts = useMemo(() => {
    const m = new Map();
    for (const c of contacts) for (const id of (c.tagIds || [])) m.set(id, (m.get(id) || 0) + 1);
    return m;
  }, [contacts]);

  // Hide tags nobody in view has, unless they're selected (a selected chip must
  // never vanish — that's how you get stuck filtering on something invisible).
  const visible = tags.filter((t) => counts.get(t.id) || selected.has(t.id));
  if (!visible.length) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <TagIcon size={13} color={BRAND.muted} style={{ flexShrink: 0 }} />
      {visible.map((t) => {
        const on = selected.has(t.id);
        return (
          <button
            key={t.id}
            onClick={() => onToggle(t.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
              fontSize: 12, fontWeight: on ? 700 : 600, fontFamily: 'inherit',
              padding: '4px 10px', borderRadius: 999,
              background: on ? t.colour : tint(t.colour, '14'),
              border: `1px solid ${t.colour}`,
              color: on ? '#fff' : '#3B4A55',
            }}
          >
            {t.label}
            <span style={{ opacity: 0.75, fontWeight: 600 }}>{counts.get(t.id) || 0}</span>
          </button>
        );
      })}
      {selected.size > 1 && (
        <button
          onClick={() => onModeChange(mode === 'any' ? 'all' : 'any')}
          title={mode === 'any' ? 'Showing contacts with ANY of the selected tags' : 'Showing contacts with ALL of the selected tags'}
          style={{
            fontSize: 11.5, fontWeight: 700, padding: '4px 9px', borderRadius: 999,
            border: '1px solid ' + BRAND.border, background: '#fff', color: BRAND.muted,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {mode === 'any' ? 'Match any' : 'Match all'}
        </button>
      )}
      {selected.size > 0 && (
        <button className="btn-link" onClick={onClear} style={{ fontSize: 12 }}>Clear</button>
      )}
    </div>
  );
}

// Apply / remove tags on one contact, plus create-on-the-fly.
export function TagPicker({ contact }) {
  const { state, actions, showMsg } = useStore();
  const [open, setOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const tags = state.tags || [];
  const applied = new Set(contact.tagIds || []);

  const create = async () => {
    const label = newLabel.trim();
    if (!label) return;
    try {
      const tag = await actions.createTag(label);
      if (tag?.id) await actions.addContactTag(contact.id, tag.id);
      setNewLabel('');
    } catch (err) {
      showMsg(err.message, 'error');
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {(contact.tagIds || []).map((id) => {
        const tag = tags.find((t) => t.id === id);
        return <TagChip key={id} tag={tag} onRemove={() => actions.removeContactTag(contact.id, id)} />;
      })}

      {open ? (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6, padding: 10,
          border: '1px solid ' + BRAND.border, borderRadius: 10, background: '#fff', minWidth: 220,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {tags.map((t) => (
              <button
                key={t.id}
                onClick={() => (applied.has(t.id)
                  ? actions.removeContactTag(contact.id, t.id)
                  : actions.addContactTag(contact.id, t.id))}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                  fontSize: 11.5, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
                  fontFamily: 'inherit',
                  background: applied.has(t.id) ? t.colour : '#fff',
                  border: `1px solid ${t.colour}`,
                  color: applied.has(t.id) ? '#fff' : '#3B4A55',
                }}
              >
                {applied.has(t.id) && <Check size={10} />}
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }}
              placeholder="New tag…"
              style={{ fontSize: 12, flex: 1 }}
            />
            <button className="btn-ghost" onClick={() => setOpen(false)} style={{ fontSize: 12 }}>Done</button>
          </div>
        </div>
      ) : (
        <button className="btn-ghost" onClick={() => setOpen(true)} style={{ fontSize: 11.5, padding: '2px 8px' }}>
          <Plus size={11} /> Tag
        </button>
      )}
    </div>
  );
}
