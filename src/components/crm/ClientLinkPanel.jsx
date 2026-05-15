import React, { useEffect, useMemo, useState } from 'react';
import { Check, Link2, AlertTriangle, UserPlus, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

// Status panel under the Client information fields. Reads `data.clientName`
// + `data.contactBusinessName` against the in-memory contacts/companies maps
// and renders one of five states:
//
//   - both-matched / linked  → green, informational
//   - contact-only           → amber: "create company, link contact"
//   - company-only           → amber: "create contact at <existing org>"
//   - none                   → amber: "create both"
//   - conflict               → orange: contact already linked to a different
//                              company; user picks
//
// Acts via the existing `update(patch)` callback on BuilderView (which calls
// saveProposal) — so saving the proposal also propagates _contactId /
// _companyId to the auto-deal. The "Create" path uses the resolver endpoint
// which atomically handles the find-or-create on the server.

export function ClientLinkPanel({ data, update, proposalId, showMsg }) {
  const { state, actions } = useStore();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissal whenever the names change so we don't permanently
  // suppress the banner across edits.
  useEffect(() => { setDismissed(false); }, [data?.clientName, data?.contactBusinessName]);

  const clientName = (data?.clientName || '').trim();
  const businessName = (data?.contactBusinessName || '').trim();
  const contactId = data?._contactId || null;
  const companyId = data?._companyId || null;

  // Local index lookup. This is purely advisory — server is authoritative.
  const indexedContact = useMemo(() => {
    if (!clientName) return null;
    const lower = clientName.toLowerCase();
    return Object.values(state.contacts || {}).find(
      (c) => !c.provisional && (c.name || '').trim().toLowerCase() === lower
    ) || null;
  }, [clientName, state.contacts]);

  const indexedCompany = useMemo(() => {
    if (!businessName) return null;
    const lower = businessName.toLowerCase();
    return Object.values(state.companies || {}).find(
      (co) => (co.name || '').trim().toLowerCase() === lower
    ) || null;
  }, [businessName, state.companies]);

  const linkedContact = contactId ? (state.contacts || {})[contactId] : null;
  const linkedCompany = companyId
    ? (state.companies || {})[companyId]
    : (linkedContact?.companyId ? (state.companies || {})[linkedContact.companyId] : null);

  // Conflict: typed business name doesn't match the company a found
  // (non-linked) contact is bound to.
  const conflict = !linkedContact
    && indexedContact
    && indexedContact.companyId
    && businessName
    && state.companies?.[indexedContact.companyId]?.name?.trim().toLowerCase() !== businessName.toLowerCase()
      ? {
          contact: indexedContact,
          existingCompany: state.companies[indexedContact.companyId],
        }
      : null;

  if (!clientName && !businessName) return null;
  if (dismissed) return null;

  // ── Already linked → green informational banner ──────────────────────────
  if (linkedContact) {
    return (
      <PanelShell colour="green">
        <Check size={14} color="#16A34A" />
        <span style={{ flex: 1, color: '#15803D' }}>
          Linked to <strong>{linkedContact.name || linkedContact.email || linkedContact.id}</strong>
          {linkedCompany && <> at <strong>{linkedCompany.name}</strong></>}
        </span>
        <button
          onClick={() => update({ _contactId: null, _companyId: null })}
          className="btn-ghost"
          style={{ fontSize: 11, padding: '3px 8px' }}
        >
          Unlink
        </button>
      </PanelShell>
    );
  }

  // ── Conflict ─────────────────────────────────────────────────────────────
  if (conflict) {
    return (
      <PanelShell colour="orange">
        <AlertTriangle size={14} color="#C2410C" />
        <span style={{ flex: 1, color: '#9A3412', minWidth: 0 }}>
          <strong>{conflict.contact.name}</strong> is in CRM but linked to{' '}
          <strong>{conflict.existingCompany.name}</strong>, not{' '}
          <strong>{businessName}</strong>.
        </span>
        <button
          onClick={() => update({
            _contactId: conflict.contact.id,
            _companyId: conflict.existingCompany.id,
            contactBusinessName: conflict.existingCompany.name,
          })}
          className="btn"
          style={{ fontSize: 11, padding: '3px 10px' }}
          disabled={busy}
        >
          Link to {conflict.existingCompany.name}
        </button>
        <DismissButton onClick={() => setDismissed(true)} />
      </PanelShell>
    );
  }

  // ── Both already exist locally → one-click link (no server call) ─────────
  if (indexedContact && (indexedCompany || !businessName)) {
    return (
      <PanelShell colour="amber">
        <Link2 size={14} color="#92400E" />
        <span style={{ flex: 1, color: '#92400E' }}>
          Already in CRM: <strong>{indexedContact.name}</strong>
          {indexedCompany && <> at <strong>{indexedCompany.name}</strong></>}
        </span>
        <button
          onClick={() => update({
            _contactId: indexedContact.id,
            _companyId: indexedCompany?.id || indexedContact.companyId || null,
            contactBusinessName:
              indexedCompany?.name
              || state.companies?.[indexedContact.companyId]?.name
              || businessName,
          })}
          className="btn"
          style={{ fontSize: 11, padding: '3px 10px' }}
        >
          Link
        </button>
        <DismissButton onClick={() => setDismissed(true)} />
      </PanelShell>
    );
  }

  // ── Company found locally but contact is new ─────────────────────────────
  if (!indexedContact && indexedCompany) {
    return (
      <PanelShell colour="amber">
        <UserPlus size={14} color="#92400E" />
        <span style={{ flex: 1, color: '#92400E' }}>
          <strong>{indexedCompany.name}</strong> is in CRM, but{' '}
          <strong>{clientName || '(unnamed contact)'}</strong> is new.
        </span>
        <button
          onClick={() => resolve('Create contact at ' + indexedCompany.name)}
          className="btn"
          style={{ fontSize: 11, padding: '3px 10px' }}
          disabled={busy || !clientName}
        >
          {busy ? 'Creating…' : 'Create contact'}
        </button>
        <DismissButton onClick={() => setDismissed(true)} />
      </PanelShell>
    );
  }

  // ── Both new — offer to create both ──────────────────────────────────────
  return (
    <PanelShell colour="amber">
      <UserPlus size={14} color="#92400E" />
      <span style={{ flex: 1, color: '#92400E' }}>
        Not in CRM yet:{' '}
        <strong>{clientName || '(unnamed)'}</strong>
        {businessName && <> · <strong>{businessName}</strong></>}.
      </span>
      <button
        onClick={() => resolve('Create')}
        className="btn"
        style={{ fontSize: 11, padding: '3px 10px' }}
        disabled={busy || (!clientName && !businessName)}
      >
        {busy ? 'Creating…' : 'Create'}
      </button>
      <DismissButton onClick={() => setDismissed(true)} />
    </PanelShell>
  );

  async function resolve(_action) {
    if (busy) return;
    setBusy(true);
    try {
      const resp = await actions.resolveProposalClient({
        clientName: clientName || null,
        businessName: businessName || null,
        proposalId: proposalId || null,
      });
      const patch = {};
      if (resp?.contact) patch._contactId = resp.contact.id;
      if (resp?.company) {
        patch._companyId = resp.company.id;
        if (!businessName) patch.contactBusinessName = resp.company.name;
      }
      update(patch);
      const made = [];
      if (resp?.created?.contact) made.push('contact');
      if (resp?.created?.company) made.push('company');
      const matched = [];
      if (resp?.matched?.contact && !resp?.created?.contact) matched.push('contact');
      if (resp?.matched?.company && !resp?.created?.company) matched.push('company');
      const parts = [];
      if (made.length) parts.push('Created ' + made.join(' + '));
      if (matched.length) parts.push('Matched ' + matched.join(' + '));
      if (parts.length && showMsg) showMsg(parts.join(' · '));
    } catch (err) {
      if (showMsg) showMsg(err?.message || 'Could not link contact');
    } finally {
      setBusy(false);
    }
  }
}

function PanelShell({ colour, children }) {
  const palette = {
    green:  { bg: '#F0FDF4', border: '#86EFAC' },
    amber:  { bg: '#FFFBEB', border: '#FDE68A' },
    orange: { bg: '#FFF7ED', border: '#FDBA74' },
  };
  const p = palette[colour] || palette.amber;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      background: p.bg,
      border: '1px solid ' + p.border,
      borderRadius: 8,
      fontSize: 12,
      marginBottom: 12,
    }}>
      {children}
    </div>
  );
}

function DismissButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="btn-ghost"
      style={{ padding: '3px 6px', lineHeight: 1 }}
      title="Dismiss"
      aria-label="Dismiss"
    >
      <X size={12} />
    </button>
  );
}
