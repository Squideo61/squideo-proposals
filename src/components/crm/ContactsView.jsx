import React, { useMemo, useState } from 'react';
import { ArrowLeft, Building2, CheckCircle2, Circle, Edit2, Plus, Search, Trash2, User, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';

export function ContactsView({ onBack, onOpenContact, onOpenCompany }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [view, setView] = useState('contacts'); // 'contacts' | 'organisations'
  const [search, setSearch] = useState('');
  const [customersOnly, setCustomersOnly] = useState(true);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  const contacts = useMemo(() => Object.values(state.contacts || {}), [state.contacts]);
  const companies = useMemo(() => Object.values(state.companies || {}), [state.companies]);

  // The "Customers" tab shows every organisation; toggling Customers Only
  // narrows it to those flagged as a customer (verified or has signed
  // proposal). Off by default for contacts (the toggle is hidden there).
  const customerCount = useMemo(
    () => companies.filter(c => c.isCustomer).length,
    [companies],
  );

  const items = view === 'contacts'
    ? contacts
    : (customersOnly ? companies.filter(c => c.isCustomer) : companies);
  const isOrgsView = view === 'organisations';

  const q = search.trim().toLowerCase();
  const filtered = q ? items.filter(c => {
    const haystack = view === 'contacts'
      ? [c.name, c.email, c.phone, c.title, state.companies[c.companyId]?.name].filter(Boolean).join(' ').toLowerCase()
      : [c.name, c.domain, c.notes].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  }) : items;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            {isOrgsView
              ? <Building2 size={22} color={BRAND.blue} />
              : <User size={22} color={BRAND.blue} />}
            {isOrgsView ? 'Organisations' : 'Contacts'}
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ display: 'flex', borderRadius: 8, border: '1px solid ' + BRAND.border, overflow: 'hidden' }}>
            <Tab active={view === 'contacts'} onClick={() => setView('contacts')}>Contacts ({contacts.length})</Tab>
            <Tab active={isOrgsView} onClick={() => setView('organisations')}>Organisations ({companies.length})</Tab>
          </div>
          <button onClick={() => setCreating(true)} className="btn">
            <Plus size={16} /> New {isOrgsView ? 'organisation' : 'contact'}
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 360 }}>
          <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={view === 'contacts' ? 'Search by name, email…' : 'Search organisations…'}
            className="input"
            style={{ paddingLeft: 34, paddingRight: search ? 34 : 12 }}
          />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear search" style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: BRAND.muted }}>
              <X size={14} />
            </button>
          )}
        </div>
        {isOrgsView && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: BRAND.ink, cursor: 'pointer', userSelect: 'none' }} title={`${customerCount} flagged as a customer`}>
            <input
              type="checkbox"
              checked={customersOnly}
              onChange={(e) => setCustomersOnly(e.target.checked)}
            />
            Customers only ({customerCount})
          </label>
        )}
      </div>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>
            {items.length === 0
              ? (view === 'contacts' ? 'No contacts yet' : (customersOnly ? 'No customers yet — verify an organisation to flag it' : 'No organisations yet'))
              : 'No matches'}
          </div>
        ) : view === 'contacts' ? (
          filtered.map(c => (
            <ContactRow
              key={c.id}
              contact={c}
              onOpen={() => onOpenContact?.(c.id)}
              onEdit={() => setEditing(c)}
            />
          ))
        ) : (
          filtered.map(c => (
            <CompanyRow
              key={c.id}
              company={c}
              onOpen={() => onOpenCompany?.(c.id)}
              onEdit={() => setEditing(c)}
              onToggleCustomer={async () => {
                try {
                  await actions.setCompanyCustomerVerified(c.id, !c.customerVerifiedAt);
                  showMsg(c.customerVerifiedAt ? 'Customer flag removed' : 'Marked as customer');
                } catch (err) { showMsg(err?.message || 'Could not update'); }
              }}
            />
          ))
        )}
      </div>

      {creating && view === 'contacts' && <ContactModal onClose={() => setCreating(false)} />}
      {creating && isOrgsView && <CompanyModal onClose={() => setCreating(false)} />}
      {editing && view === 'contacts' && <ContactModal contact={editing} onClose={() => setEditing(null)} />}
      {editing && isOrgsView && <CompanyModal company={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Tab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 14px',
        background: active ? BRAND.blue : 'white',
        color: active ? 'white' : BRAND.ink,
        border: 'none',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function ContactRow({ contact, onOpen, onEdit }) {
  const { state } = useStore();
  const company = contact.companyId ? state.companies[contact.companyId] : null;
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', borderTop: '1px solid ' + BRAND.border, background: 'white' }}>
      <button
        onClick={onOpen}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', border: 'none', flex: 1, background: 'transparent', minWidth: 0 }}
      >
        <div style={{ width: 32, height: 32, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
          {(contact.name || contact.email || '?')[0].toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{contact.name || contact.email || 'Unnamed'}</div>
          <div style={{ fontSize: 12, color: BRAND.muted, display: 'flex', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
            {contact.email && <span>{contact.email}</span>}
            {company && <span>· {company.name}</span>}
            {contact.title && <span>· {contact.title}</span>}
          </div>
        </div>
      </button>
      <button
        onClick={onEdit}
        title="Edit contact"
        aria-label="Edit contact"
        style={{ padding: '0 16px', background: 'transparent', border: 'none', cursor: 'pointer', color: BRAND.muted }}
      >
        <Edit2 size={14} />
      </button>
    </div>
  );
}

function CompanyRow({ company, onOpen, onEdit, onToggleCustomer }) {
  // Visual hierarchy:
  //   - Green check + "Customer" label when verified by an admin
  //   - Blue check + "Signed customer" when auto-derived from a signed proposal
  //   - Outlined circle button "Mark as customer" otherwise
  const isVerified = !!company.customerVerifiedAt;
  const isAutoCustomer = !isVerified && !!company.hasSignedProposal;
  const isCustomer = isVerified || isAutoCustomer;
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', borderTop: '1px solid ' + BRAND.border, background: 'white' }}>
      <button
        onClick={onOpen}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', border: 'none', flex: 1, background: 'transparent', minWidth: 0 }}
      >
        <div style={{ width: 32, height: 32, borderRadius: 8, background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Building2 size={16} color={BRAND.muted} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span>{company.name}</span>
            {isVerified && <CustomerBadge label="Customer" tone="green" title={'Verified by ' + (company.customerVerifiedBy || 'admin')} />}
            {isAutoCustomer && <CustomerBadge label="Signed customer" tone="blue" title="Has at least one signed proposal" />}
          </div>
          {company.domain && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{company.domain}</div>}
        </div>
      </button>
      <button
        onClick={onToggleCustomer}
        title={isVerified ? 'Unmark as customer' : 'Mark as customer'}
        aria-label={isVerified ? 'Unmark as customer' : 'Mark as customer'}
        style={{ padding: '0 14px', background: 'transparent', border: 'none', cursor: 'pointer', color: isCustomer ? '#16A34A' : BRAND.muted, display: 'flex', alignItems: 'center' }}
      >
        {isVerified ? <CheckCircle2 size={16} /> : <Circle size={16} />}
      </button>
      <button
        onClick={onEdit}
        title="Edit organisation"
        aria-label="Edit organisation"
        style={{ padding: '0 16px', background: 'transparent', border: 'none', cursor: 'pointer', color: BRAND.muted }}
      >
        <Edit2 size={14} />
      </button>
    </div>
  );
}

function CustomerBadge({ label, tone, title }) {
  const palette = {
    green: { bg: '#DCFCE7', fg: '#15803D' },
    blue:  { bg: '#DBEAFE', fg: '#1E40AF' },
  };
  const p = palette[tone] || palette.green;
  return (
    <span
      title={title}
      style={{
        background: p.bg,
        color: p.fg,
        fontSize: 10,
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: 4,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {label}
    </span>
  );
}

function ContactModal({ contact, onClose }) {
  const { state, actions } = useStore();
  const editing = !!contact;
  const [name, setName] = useState(contact?.name || '');
  const [email, setEmail] = useState(contact?.email || '');
  const [phone, setPhone] = useState(contact?.phone || '');
  const [title, setTitle] = useState(contact?.title || '');
  const [companyId, setCompanyId] = useState(contact?.companyId || '');
  const [notes, setNotes] = useState(contact?.notes || '');
  const [submitting, setSubmitting] = useState(false);
  const companies = Object.values(state.companies || {});

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const payload = {
      name: name.trim() || null,
      email: email.trim() || null,
      phone: phone.trim() || null,
      title: title.trim() || null,
      companyId: companyId || null,
      notes: notes.trim() || null,
    };
    if (editing) await actions.saveContact(contact.id, payload);
    else await actions.createContact(payload);
    setSubmitting(false);
    onClose();
  };

  const handleDelete = () => {
    if (!editing) return;
    if (!window.confirm('Delete this contact?')) return;
    actions.deleteContact(contact.id);
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>{editing ? 'Edit contact' : 'New contact'}</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Row>
        <Row label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Row>
        <Row label="Phone"><input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Row>
        <Row label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Row>
        <Row label="Company">
          <select className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">—</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Row>
        <Row label="Notes"><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} /></Row>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 8 }}>
          {editing
            ? <button type="button" onClick={handleDelete} className="btn-ghost is-danger"><Trash2 size={14} /> Delete</button>
            : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn" disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function CompanyModal({ company, onClose }) {
  const { actions } = useStore();
  const editing = !!company;
  const [name, setName] = useState(company?.name || '');
  const [domain, setDomain] = useState(company?.domain || '');
  const [notes, setNotes] = useState(company?.notes || '');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    const payload = { name: name.trim(), domain: domain.trim() || null, notes: notes.trim() || null };
    if (editing) await actions.saveCompany(company.id, payload);
    else await actions.createCompany(payload);
    setSubmitting(false);
    onClose();
  };

  const handleDelete = () => {
    if (!editing) return;
    if (!window.confirm('Delete this company? Contacts will keep existing but lose the company link.')) return;
    actions.deleteCompany(company.id);
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>{editing ? 'Edit company' : 'New company'}</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required /></Row>
        <Row label="Domain (e.g. example.com)"><input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" /></Row>
        <Row label="Notes"><textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} /></Row>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 8 }}>
          {editing
            ? <button type="button" onClick={handleDelete} className="btn-ghost is-danger"><Trash2 size={14} /> Delete</button>
            : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn" disabled={!name.trim() || submitting}>{submitting ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function Row({ label, children }) {
  return (
    <label style={{ fontSize: 13, fontWeight: 500, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}
