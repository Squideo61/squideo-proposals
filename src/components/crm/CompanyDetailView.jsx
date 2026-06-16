import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Award, Building2, CheckCircle2, Circle, FileText, Globe, MapPin, Percent, User, Edit2, Link2, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile, formatGBP, formatRelativeTime, effectiveAddress, formatAddressLines } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { InvoicesPaymentsCard } from './InvoicesPaymentsCard.jsx';
import { PIPELINE_STAGES } from './PipelineView.jsx';
import { XeroContactPicker } from './XeroContactPicker.jsx';
import { CompanyModal } from './ContactsView.jsx';

export function CompanyDetailView({ companyId, onBack, onOpenDeal, onOpenContact }) {
  const { actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [xeroContact, setXeroContact] = useState(null);
  const [creatingXero, setCreatingXero] = useState(false);
  // Banner "Create invoice" → opens the invoices card's create modal, preselecting the deal.
  const [createSignal, setCreateSignal] = useState(0);
  const [preselectDealId, setPreselectDealId] = useState(null);

  const reload = () => api.get('/api/crm/companies/' + encodeURIComponent(companyId) + '/detail').then(setDetail);

  useEffect(() => {
    if (!companyId) return;
    api.get('/api/crm/companies/' + encodeURIComponent(companyId) + '/detail')
      .then(setDetail)
      .catch((err) => showMsg?.(err.message || 'Failed to load company', 'error'));
  }, [companyId, showMsg]);

  // Lifetime value rollup, computed server-side from every paid source (Stripe,
  // Partner, manual payments, paid manual invoices, and paid Xero invoices) so
  // it always agrees with the outstanding-balance figures.
  const lifetimeTotals = detail?.lifetime
    ? { ...detail.lifetime, year: new Date().getFullYear() }
    : null;

  // The customer's VAT rate (fraction). All money figures on this page are
  // stored inc-VAT, so divide by (1 + rate) and append "+VAT" to show them the
  // way they're quoted/invoiced. fmtEx: inc-VAT input; fmtExNet: already-ex input.
  const vatRate = Number(detail?.balance?.vatRate) || 0;
  const vatPct = Math.round(vatRate * 1000) / 10;
  const vatSuffix = vatRate > 0 ? ' +VAT' : '';
  const fmtEx = (inc) => formatGBP((Number(inc) || 0) / (1 + vatRate)) + vatSuffix;
  const fmtExNet = (net) => formatGBP(Number(net) || 0) + vatSuffix;

  async function removeContactFromOrg(contact) {
    if (!window.confirm(`Remove ${contact.name || contact.email || 'this contact'} from ${detail?.name || 'this organisation'}? They'll stay in your contacts and any other organisations.`)) return;
    try {
      await actions.removeContactFromCompany(contact.id, companyId);
      showMsg?.('Removed from organisation', 'success');
      reload();
    } catch (err) {
      showMsg?.(err.message || 'Failed to remove', 'error');
    }
  }

  async function handleSaveLink() {
    if (!xeroContact) return;
    try {
      await api.patch('/api/crm/companies/' + encodeURIComponent(companyId), { xeroContactId: xeroContact.id });
      showMsg?.(`Linked to Xero: ${xeroContact.name}`, 'success');
      setLinking(false);
      setXeroContact(null);
      reload();
    } catch (err) {
      showMsg?.(err.message || 'Failed to link', 'error');
    }
  }

  async function handleCreateXero() {
    if (creatingXero) return;
    setCreatingXero(true);
    try {
      const updated = await api.post('/api/crm/companies/' + encodeURIComponent(companyId) + '/create-xero-contact');
      showMsg?.(`Created Xero contact: ${updated?.xeroContactName || detail.name}`, 'success');
      setLinking(false);
      setXeroContact(null);
      reload();
    } catch (err) {
      showMsg?.(err.message || 'Failed to create Xero contact', 'error');
    } finally {
      setCreatingXero(false);
    }
  }

  async function handleUnlink() {
    if (!confirm('Unlink this company from its Xero contact?')) return;
    try {
      await api.patch('/api/crm/companies/' + encodeURIComponent(companyId), { xeroContactId: null });
      showMsg?.('Unlinked', 'success');
      reload();
    } catch (err) {
      showMsg?.(err.message || 'Failed to unlink', 'error');
    }
  }

  async function toggleCustomer() {
    if (!detail) return;
    const next = !detail.customerVerifiedAt;
    try {
      await actions.setCompanyCustomerVerified(companyId, next);
      showMsg?.(next ? 'Marked as customer' : 'Customer flag removed', 'success');
      reload();
    } catch (err) {
      showMsg?.(err?.message || 'Could not update customer status', 'error');
    }
  }

  if (!detail) {
    return (
      <div style={{ padding: 32 }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Contacts</button>
        <button onClick={() => setEditing(true)} className="btn-ghost"><Edit2 size={14} /> Edit company</button>
      </header>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Building2 size={22} color={BRAND.blue} />
            <span>{detail.name}</span>
            {detail.customerVerifiedAt && (
              <span title={'Verified by ' + (detail.customerVerifiedBy || 'admin')} style={{ background: '#DCFCE7', color: '#15803D', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Award size={11} /> Customer
              </span>
            )}
            {!detail.customerVerifiedAt && detail.hasSignedProposal && (
              <span title="Has at least one signed proposal" style={{ background: '#DBEAFE', color: '#1E40AF', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Signed customer
              </span>
            )}
          </h1>
          {/* Customer-status + Xero-link controls, top-right of the card. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'flex-end' }}>
            <button
              onClick={toggleCustomer}
              className="btn-ghost"
              title={detail.customerVerifiedAt
                ? `Verified by ${detail.customerVerifiedBy || 'admin'} — click to unmark`
                : detail.hasSignedProposal ? 'Auto-flagged via a signed proposal — click to verify' : 'Mark as customer'}
            >
              {detail.customerVerifiedAt
                ? <><CheckCircle2 size={14} color="#16A34A" /> Verified customer</>
                : <><Circle size={14} /> Mark as customer</>}
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, paddingLeft: 2 }}>
                Xero link
              </span>
              {detail.xeroContactId ? (
                <button
                  onClick={handleUnlink}
                  className="btn-ghost"
                  title={`Linked to ${detail.xeroContactName || detail.xeroContactId} — click to unlink`}
                  style={{ color: '#15803D' }}
                >
                  <Link2 size={14} color="#16A34A" /> {detail.xeroContactName || 'Xero linked'} <X size={11} />
                </button>
              ) : (
                <button onClick={() => setLinking(v => !v)} className="btn-ghost">
                  <Link2 size={14} /> Link Xero contact
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Xero contact picker — appears while linking. */}
        {linking && !detail.xeroContactId && (
          <div style={{ marginBottom: 16, padding: 12, border: '1px solid ' + BRAND.border, borderRadius: 8, background: '#F8FAFC' }}>
            <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
              Link to a Xero contact
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <XeroContactPicker
                value={xeroContact}
                onChange={setXeroContact}
                placeholder={`Search Xero for "${detail.name}"…`}
                autoFocus
                initialQuery={detail.name}
                onCreateNew={handleCreateXero}
                createNewLabel={`Create “${detail.name}” in Xero`}
                creatingNew={creatingXero}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button onClick={() => { setLinking(false); setXeroContact(null); }} className="btn-ghost">Cancel</button>
                <button onClick={handleSaveLink} className="btn" disabled={!xeroContact}>Link</button>
              </div>
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 16 }}>
          <Field icon={Globe} label="Domain">{detail.domain || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field label="Contacts">{detail.contacts.length}</Field>
          <Field icon={MapPin} label="Address">
            {(() => {
              const lines = formatAddressLines(effectiveAddress(detail));
              return lines.length
                ? <span style={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</span>
                : <span style={{ color: BRAND.muted }}>—</span>;
            })()}
          </Field>
          <Field icon={Percent} label="VAT rate">{vatRate > 0 ? `${vatPct}%` : <span style={{ color: BRAND.muted }}>No VAT</span>}</Field>
        </div>

        {/* Billing status on signed work, as a card above lifetime value. Three
            states: red → signed >1h with no invoice raised; amber → invoiced but
            still owed; green → all signed work paid. */}
        {detail.balance && detail.balance.committed > 0 && (() => {
          // Owed = remaining on signed work + any unpaid ad-hoc invoices,
          // computed server-side so the breakdown below always agrees.
          const signedRemaining = Number(detail.balance.signedRemaining) || 0;
          const extra = Number(detail.balance.unpaidExtraInvoices) || 0;
          const owed = Number(detail.balance.outstanding) || 0;
          const needs = detail.balance.needsInvoice;
          const tone = needs
            ? { bg: '#FEE2E2', border: '#FCA5A5', fg: '#991B1B' }
            : owed > 0
            ? { bg: '#FEF3C7', border: '#FDE68A', fg: '#92400E' }
            : { bg: '#F0FDF4', border: '#BBF7D0', fg: '#15803D' };
          const label = needs ? 'Invoice needs generating' : owed > 0 ? 'Outstanding balance' : 'All signed work paid';
          return (
            <div style={{ marginTop: 16, background: tone.bg, border: '1px solid ' + tone.border, borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: tone.fg, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700, marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: tone.fg }}>{fmtEx(owed)}{owed > 0 ? ' owed' : ''}</div>
                <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
                  {fmtEx(detail.balance.committed)} signed · {fmtEx(detail.balance.paid)} paid
                  {detail.balance.paidViaXeroInvoices > 0 && ` (incl. ${fmtEx(detail.balance.paidViaXeroInvoices)} via Xero invoices)`}
                  {extra > 0 && ` — ${fmtEx(signedRemaining)} on signed work + ${fmtEx(extra)} other unpaid invoices`}
                </div>
              </div>
              {needs && (
                <button
                  onClick={() => { setPreselectDealId(detail.balance.needsInvoiceDealId || null); setCreateSignal(n => n + 1); }}
                  className="btn"
                  style={{ fontSize: 12, background: '#DC2626' }}
                >
                  <FileText size={13} /> Create invoice
                </button>
              )}
            </div>
          );
        })()}

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid ' + BRAND.border }}>
          <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 }}>
            Lifetime value
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)', gap: 12 }}>
            <Stat
              label="Lifetime spend"
              value={lifetimeTotals ? fmtEx(lifetimeTotals.lifetime) : '…'}
              hint={lifetimeTotals ? `${lifetimeTotals.count} payment${lifetimeTotals.count === 1 ? '' : 's'}` : null}
            />
            <Stat
              label={lifetimeTotals ? `This year (${lifetimeTotals.year})` : 'This year'}
              value={lifetimeTotals ? fmtEx(lifetimeTotals.thisYear) : '…'}
            />
            <Stat
              label="First payment"
              value={lifetimeTotals
                ? (lifetimeTotals.firstPaymentAt
                    ? new Date(lifetimeTotals.firstPaymentAt).toLocaleDateString('en-GB')
                    : '—')
                : '…'}
            />
          </div>
        </div>

        {detail.notes && (
          <div style={{ marginTop: 16, padding: 12, background: '#F8FAFC', borderRadius: 8, fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {detail.notes}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <Card
          title="Contacts"
          count={detail.contacts.length}
          action={<AddContactPicker companyId={companyId} existingIds={detail.contacts.map(c => c.id)} onAdded={reload} />}
        >
          {detail.contacts.length === 0 && <Empty text="No contacts at this company" />}
          {detail.contacts.map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'stretch', gap: 6, marginBottom: 6 }}>
              <button
                onClick={() => onOpenContact?.(c.id)}
                style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {c.name || c.email || c.id}
                    {c.isPrimary === false && <span style={{ fontSize: 10, fontWeight: 600, color: BRAND.muted, marginLeft: 6 }}>· also at other orgs</span>}
                  </div>
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
                    {c.title}{c.title && c.email && ' · '}{c.email}
                  </div>
                </div>
                <User size={14} color={BRAND.muted} />
              </button>
              <button
                type="button"
                onClick={() => removeContactFromOrg(c)}
                title="Remove from this organisation"
                aria-label="Remove from this organisation"
                style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, color: BRAND.muted, cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </Card>

        <Card title="Deals" count={detail.deals.length}>
          {detail.deals.length === 0 && <Empty text="No deals at this company" />}
          {detail.deals.map(d => {
            const stage = PIPELINE_STAGES.find(s => s.id === d.stage);
            return (
              <button
                key={d.id}
                onClick={() => onOpenDeal?.(d.id)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', marginBottom: 6 }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{d.title}</div>
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
                    {stage?.label || d.stage}
                    {d.value != null && <> · {fmtExNet(d.value)}</>}
                    {d.lastActivityAt && <> · {formatRelativeTime(d.lastActivityAt)}</>}
                  </div>
                </div>
                {d.balance && d.balance.committed > 0 && (
                  d.balance.outstanding > 0
                    ? <span style={{ fontSize: 12, fontWeight: 700, color: '#92400E', whiteSpace: 'nowrap' }}>{fmtEx(d.balance.outstanding)} owed</span>
                    : <span style={{ fontSize: 11, fontWeight: 700, color: '#15803D', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: 0.4 }}>Paid</span>
                )}
              </button>
            );
          })}
        </Card>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <InvoicesPaymentsCard companyId={companyId} contactName={detail.name} deals={detail.deals} vatRate={vatRate} onChanged={reload} openCreateSignal={createSignal} preselectDealId={preselectDealId} />
        </div>
      </div>

      {editing && (
        <CompanyModal
          company={detail}
          onClose={() => { setEditing(false); reload(); }}
        />
      )}
    </div>
  );
}

function Field({ icon: Icon, label, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 }}>
        {Icon && <Icon size={11} />}
        {label}
      </div>
      <div style={{ fontSize: 14 }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

// "+ Add contact" on a company's Contacts card — links an EXISTING contact to
// this organisation. A contact has a single company, so picking one that's
// already at another org reassigns it here (the row flags that). Uses
// saveContact (optimistic + undoable) then reloads the company detail.
function AddContactPicker({ companyId, existingIds, onAdded }) {
  const { state, actions, showMsg } = useStore();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const here = new Set(existingIds || []);
  const candidates = useMemo(() => {
    const term = q.trim().toLowerCase();
    return Object.values(state.contacts || {})
      .filter(c => c && c.id && !here.has(c.id))
      .filter(c => !term || (c.name || '').toLowerCase().includes(term) || (c.email || '').toLowerCase().includes(term))
      .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.contacts, companyId, q]);

  const add = async (c) => {
    setBusy(true);
    try {
      // Additive: the contact can belong to several organisations at once.
      await actions.addContactToCompany(c.id, companyId);
      showMsg?.(`${c.name || c.email || 'Contact'} added to this organisation`, 'success');
      setOpen(false);
      setQ('');
      onAdded?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to add contact', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)} className="btn-ghost" style={{ fontSize: 12 }}>+ Add contact</button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50, width: 280,
          background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
          boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)', padding: 8,
        }}>
          <input
            className="input"
            autoFocus
            placeholder="Search contacts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ fontSize: 13, marginBottom: 6 }}
          />
          <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {candidates.length === 0 && (
              <div style={{ fontSize: 12, color: BRAND.muted, fontStyle: 'italic', padding: '6px 4px' }}>
                {q ? 'No matching contacts' : 'Type to search your contacts'}
              </div>
            )}
            {candidates.map(c => {
              // Other organisations this contact is already in (informational —
              // adding here is additive, it doesn't move them).
              const otherOrgs = (c.companyIds && c.companyIds.length ? c.companyIds : (c.companyId ? [c.companyId] : []))
                .map(cid => state.companies?.[cid]?.name).filter(Boolean);
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  onClick={() => add(c)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, width: '100%', padding: '6px 8px', border: 'none', background: 'transparent', borderRadius: 6, cursor: busy ? 'default' : 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink }}>{c.name || c.email || c.id}</span>
                  <span style={{ fontSize: 11, color: BRAND.muted }}>
                    {c.name && c.email ? c.email : ''}
                    {otherOrgs.length ? `${c.name && c.email ? ' · ' : ''}also at ${otherOrgs.join(', ')}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
