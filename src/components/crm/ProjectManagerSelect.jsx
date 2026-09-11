import React, { useState } from 'react';
import { Rocket } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Modal } from '../ui.jsx';

// Who can manage a project: every staff member, with the Project/Production
// Managers (role 'member') listed first. Freelancers are external contractors
// scoped to their own assignments, so they're never offered.
function projectManagerOptions(users) {
  const list = Object.entries(users || {})
    .map(([email, u]) => ({ email, name: u?.name || email, role: u?.role || null }))
    .filter((u) => u.role !== 'freelancer');
  const byName = (a, b) => a.name.localeCompare(b.name);
  return {
    managers: list.filter((u) => u.role === 'member').sort(byName),
    others: list.filter((u) => u.role !== 'member').sort(byName),
  };
}

// A single-choice picker for a project's manager. `value` is an email or ''.
export function ProjectManagerSelect({ value, onChange, disabled = false, placeholder = 'Choose a project manager…', style }) {
  const { state } = useStore();
  const { managers, others } = projectManagerOptions(state.users);
  // Keep a current value visible even if that person isn't in the list any more.
  const known = [...managers, ...others].some((u) => u.email.toLowerCase() === String(value || '').toLowerCase());
  return (
    <select
      className="input"
      value={value || ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: '100%', boxSizing: 'border-box', ...style }}
    >
      <option value="">{placeholder}</option>
      {value && !known && <option value={value}>{value}</option>}
      {managers.length > 0 && (
        <optgroup label="Project managers">
          {managers.map((u) => <option key={u.email} value={u.email}>{u.name}</option>)}
        </optgroup>
      )}
      {others.length > 0 && (
        <optgroup label={managers.length ? 'Everyone else' : 'Team'}>
          {others.map((u) => <option key={u.email} value={u.email}>{u.name}</option>)}
        </optgroup>
      )}
    </select>
  );
}

// Tell the person what happened to an already-booked kick-off when a project
// manager was set — they were added to the invite, or it needs doing by hand.
export function kickoffInviteMessage(kickoffInvite, name) {
  if (!kickoffInvite) return null;
  if (kickoffInvite.error) return kickoffInvite.error;
  if (kickoffInvite.added > 0) return `${name || 'The project manager'} has been added to the booked kick-off call`;
  return null;
}

// "Good to go" confirmation: pick the project manager, then move the deal into
// production. Replaces the old bare confirm() — the PM is chosen here because
// they're who runs the project and who's invited to the client's kick-off.
export function GoodToGoModal({ deal, onClose, onDone }) {
  const { state, actions, showMsg } = useStore();
  const me = state.session?.email || '';
  const meIsManager = state.users?.[me]?.role === 'member';
  const [pm, setPm] = useState(deal.projectManagerEmail || (meIsManager ? me : ''));
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!pm || saving) return;
    setSaving(true);
    try {
      const resp = await actions.markDealGoodToGo(deal.id, pm);
      const pmName = state.users?.[pm]?.name || pm;
      const extra = kickoffInviteMessage(resp?.kickoffInvite, pmName);
      showMsg(`Good to go — moved to Projects with ${pmName} as project manager${extra ? `. ${extra}` : ''}`);
      onDone?.();
    } catch (err) {
      showMsg(err?.message || 'Could not mark good to go');
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={460}>
      <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700 }}>Mark “Good to go”</h2>
      <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 16 }}>
        <strong style={{ color: BRAND.ink }}>{deal.title || 'This deal'}</strong> moves into Projects (production) and the
        project managers are told. This can’t be undone.
      </div>
      <label style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        Project manager
      </label>
      <ProjectManagerSelect value={pm} onChange={setPm} disabled={saving} />
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 6 }}>
        They run the project and are invited to the client’s kick-off call — the times the client can pick will suit their calendar.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button onClick={onClose} className="btn-ghost" disabled={saving}>Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!pm || saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Rocket size={14} /> {saving ? 'Moving…' : 'Good to go'}
        </button>
      </div>
    </Modal>
  );
}
