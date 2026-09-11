// Shared pieces for Squideo Academy in the CRM: the Academies page and the
// Academy card on a company page both show an academy the same way, and raise
// its invoices through the same window.
//
// Money on the academy platform is in pence; by the time it reaches here the
// CRM's own server has turned what matters into pounds (due lines, invoices),
// and plan prices are converted on display.
import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { formatGBP } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { CompanySearchPicker } from './CompanySearchPicker.jsx';

const VAT_RATE = 0.2;
export const penceGBP = (p) => formatGBP((Number(p) || 0) / 100);

export function fmtDay(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// "Starter, monthly" / "Team, annual" / "Free trial" / "Custom".
export function planText(a) {
  const s = a.summary || {};
  if (s.trial?.phase && s.trial.phase !== 'none') {
    const after = s.afterTrial && s.afterTrial.slug !== 'free' ? `, then ${s.afterTrial.name}` : '';
    return `Free trial${after}`;
  }
  const name = s.plan?.name || 'No plan';
  return s.billingPeriod && s.plan?.monthly > 0 ? `${name}, ${s.billingPeriod}` : name;
}

// What it brings in a month, or what it will after its trial.
export function valueText(a) {
  if (a.monthlyValue > 0) return `${penceGBP(a.monthlyValue)} a month`;
  if (a.monthlyValueAfterTrial > 0) return `${penceGBP(a.monthlyValueAfterTrial)} a month after the trial`;
  if (a.monthlyValue === null) return 'Agreed separately';
  return '£0';
}

export function usageText(a) {
  const s = a.summary || {};
  const n = s.usage?.thisMonth ?? 0;
  return Number.isFinite(s.cap) ? `${n} of ${s.cap}` : String(n);
}

// When the trial ends, or when the plan next renews.
export function datesText(a) {
  const s = a.summary || {};
  if (s.trial?.phase === 'running') return `Trial ends ${fmtDay(s.trial.endsAt)}`;
  if (s.trial?.phase === 'waiting') return 'Trial starts with the first course';
  if (s.renewsAt) return `Renews ${fmtDay(s.renewsAt)}`;
  return '';
}

const FLAG_TONES = {
  to_invoice: { color: '#B45309', bg: '#FFFBEB' },
  requested: { color: '#1D4ED8', bg: '#EFF6FF' },
  trial_ending: { color: '#7C3AED', bg: '#F5F3FF' },
  renewal: { color: '#0E7490', bg: '#ECFEFF' },
  over: { color: '#15803D', bg: '#ECFDF3' },
  low_usage: { color: '#B91C1C', bg: '#FEF2F2' },
};

export function FlagChips({ flags }) {
  if (!flags?.length) return <span style={{ color: BRAND.muted, fontSize: 12.5 }}>Nothing</span>;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {flags.map((f) => {
        const tone = FLAG_TONES[f.kind] || { color: BRAND.muted, bg: BRAND.paper };
        return (
          <span key={f.kind} style={{ fontSize: 11.5, fontWeight: 600, color: tone.color, background: tone.bg, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
            {f.label}
          </span>
        );
      })}
    </span>
  );
}

const STATUS = {
  paid: { label: 'Paid', color: '#15803D', bg: '#ECFDF3' },
  issued: { label: 'Awaiting payment', color: '#B45309', bg: '#FFFBEB' },
  void: { label: 'Void', color: BRAND.muted, bg: BRAND.paper },
};

// One billed line: which invoice it went on and where that invoice stands.
export function InvoiceLine({ row, canInvoice, onUnmark }) {
  const status = row.invoice ? (STATUS[row.invoice.status] || STATUS.issued) : null;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 13, padding: '5px 0', borderTop: '1px solid ' + BRAND.border }}>
      <span style={{ flex: 1, minWidth: 180, color: BRAND.ink }}>{row.label || row.periodKey}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatGBP(row.amountExVat)}</span>
      {status && (
        <span style={{ fontSize: 11.5, fontWeight: 600, color: status.color, background: status.bg, borderRadius: 999, padding: '2px 8px' }}>
          {row.invoice.number ? `${row.invoice.number} · ` : ''}{status.label}
        </span>
      )}
      {row.invoice?.pdfUrl && (
        <a href={row.invoice.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>PDF</a>
      )}
      {!row.invoice && (
        <span style={{ fontSize: 12, color: BRAND.muted }}>
          {row.source === 'elsewhere' ? `Billed elsewhere${row.note ? `: ${row.note}` : ''}` : 'Invoice not confirmed'}
        </span>
      )}
      {!row.invoice && canInvoice && onUnmark && (
        <button className="btn-ghost" style={{ fontSize: 12, padding: '2px 6px' }} onClick={() => onUnmark(row)}>Undo</button>
      )}
    </div>
  );
}

/**
 * Raise one Xero invoice for an academy: the lines that are due (worked out by
 * the server, which ignores any amount sent for them) plus any extra lines, such
 * as moving up for the rest of the year or a set-up fee. Each due line can
 * instead be marked as billed some other way, for a period invoiced before the
 * CRM kept track.
 */
export function AcademyInvoiceModal({ academy, onClose, onDone }) {
  const [picked, setPicked] = useState(() => new Set((academy.due || []).map((l) => l.periodKey)));
  const [custom, setCustom] = useState([]);
  const [email, setEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The due line being marked as billed some other way, and its note.
  const [marking, setMarking] = useState(null);
  const [note, setNote] = useState('');
  // An invoice raised that Xero could not email: said here, not lost in a close.
  const [unsent, setUnsent] = useState(null);

  const lines = useMemo(() => [
    ...(academy.due || []).filter((l) => picked.has(l.periodKey)),
    ...custom.filter((c) => c.label.trim() && Number(c.amount) > 0).map((c) => ({ ...c, amount: Number(c.amount) })),
  ], [academy.due, picked, custom]);
  const net = lines.reduce((s, l) => s + l.amount, 0);

  const toggle = (key) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const raise = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        lines: [
          ...(academy.due || []).filter((l) => picked.has(l.periodKey)).map((l) => ({ kind: l.kind, periodKey: l.periodKey })),
          ...custom.filter((c) => c.label.trim() && Number(c.amount) > 0).map((c) => ({ kind: 'custom', label: c.label.trim(), amount: Number(c.amount) })),
        ],
        email,
      };
      const r = await api.post(`/api/crm/academies/${academy.id}/invoice`, body);
      if (email && r.invoice && !r.invoice.emailed) {
        setUnsent(r);
        setBusy(false);
        return;
      }
      onDone(r.academy, r.invoice);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const markElsewhere = async (line) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/crm/academies/${academy.id}/mark-invoiced`, { kind: line.kind, periodKey: line.periodKey, note });
      onDone(r.academy, null);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (unsent) {
    const finish = () => onDone(unsent.academy, unsent.invoice);
    return (
      <Modal onClose={finish} maxWidth={460}>
        <h2 style={{ margin: '0 0 6px', fontSize: 17, color: BRAND.ink }}>Invoice raised, not sent</h2>
        <p style={{ margin: '0 0 16px', fontSize: 13.5, color: BRAND.ink }}>
          {unsent.invoice.invoiceNumber || 'The invoice'} is in Xero, but Xero could not email it, usually because the
          contact has no email address. Send it from Xero.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" type="button" onClick={finish}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} maxWidth={560}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17, color: BRAND.ink }}>Invoice {academy.name}</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted }}>
        One Xero invoice to {academy.company?.name || 'the linked company'}. Amounts are ex VAT; 20% VAT is added.
        It lands in Pending Payments, and counts as income once Xero says it is paid.
      </p>

      {(academy.due || []).length > 0 ? (
        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
          {academy.due.map((l) => (
            <div key={l.periodKey} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13.5 }}>
              <input type="checkbox" id={`due-${l.periodKey}`} checked={picked.has(l.periodKey)} onChange={() => toggle(l.periodKey)} style={{ marginTop: 3 }} />
              <div style={{ flex: 1 }}>
                <label htmlFor={`due-${l.periodKey}`} style={{ cursor: 'pointer' }}>{l.label}</label>
                {marking === l.periodKey ? (
                  <span style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
                    <input className="input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus
                      placeholder="Where it was billed, or its invoice number" aria-label="Note for the record"
                      style={{ flex: 1, fontSize: 12.5 }} />
                    <button className="btn-ghost" type="button" onClick={() => markElsewhere(l)} disabled={busy} style={{ fontSize: 12 }}>Mark as billed</button>
                    <button className="btn-ghost" type="button" onClick={() => setMarking(null)} disabled={busy} style={{ fontSize: 12 }}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn-ghost" type="button" onClick={() => { setMarking(l.periodKey); setNote(''); }} disabled={busy}
                    style={{ display: 'block', fontSize: 12, padding: 0, marginTop: 2, color: BRAND.muted }}>
                    Already billed some other way?
                  </button>
                )}
              </div>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatGBP(l.amount)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 12px' }}>Nothing is due right now. You can still invoice an extra line below.</p>
      )}

      {custom.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <input className="input" placeholder="Description, e.g. Move to Team for the rest of the year"
            value={c.label} onChange={(e) => setCustom((arr) => arr.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            style={{ flex: 1, fontSize: 13 }} aria-label="Line description" />
          <input className="input" type="number" min="0" step="0.01" placeholder="£ ex VAT"
            value={c.amount} onChange={(e) => setCustom((arr) => arr.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
            style={{ width: 110, fontSize: 13 }} aria-label="Amount ex VAT" />
          <button className="btn-ghost" type="button" aria-label="Remove line" onClick={() => setCustom((arr) => arr.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button className="btn-ghost" type="button" style={{ fontSize: 12.5, marginBottom: 14 }}
        onClick={() => setCustom((arr) => [...arr, { label: '', amount: '' }])}>
        <Plus size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Add a line
      </button>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: BRAND.ink, marginBottom: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
        Email it to {academy.company?.name || 'the client'} from Xero
      </label>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, padding: '10px 0', borderTop: '1px solid ' + BRAND.border }}>
        <span style={{ color: BRAND.muted }}>{formatGBP(net)} + {formatGBP(net * VAT_RATE)} VAT</span>
        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatGBP(net * (1 + VAT_RATE))}</strong>
      </div>
      {error && <p role="alert" style={{ color: '#B91C1C', fontSize: 13, margin: '0 0 10px' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" type="button" onClick={raise} disabled={busy || !lines.length}>
          {busy ? 'Raising…' : 'Raise invoice in Xero'}
        </button>
      </div>
    </Modal>
  );
}

// Which company an academy belongs to. The link lives on the academy platform
// (tenants.crm_company_id), so it is the same whichever side looks.
export function LinkCompanyModal({ academy, onClose, onDone }) {
  const [companyId, setCompanyId] = useState(academy.company?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async (value) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/crm/academies/${academy.id}/link`, { companyId: value || null });
      onDone(r.academy);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={480} overflow="visible">
      <h2 style={{ margin: '0 0 4px', fontSize: 17, color: BRAND.ink }}>Link {academy.name} to a company</h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: BRAND.muted }}>
        Invoices for the academy go to this company, and it shows on the company page.
      </p>
      <CompanySearchPicker value={companyId} onChange={setCompanyId} autoFocus allowCreate={false} />
      {error && <p role="alert" style={{ color: '#B91C1C', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        {academy.company && (
          <button className="btn-ghost" type="button" onClick={() => save(null)} disabled={busy} style={{ marginRight: 'auto' }}>Unlink</button>
        )}
        <button className="btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" type="button" onClick={() => save(companyId)} disabled={busy || !companyId}>
          {busy ? 'Saving…' : 'Link'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Whether an academy's invoices raise themselves. When on, the daily job puts
 * everything due on one Xero invoice each morning and Xero emails it; the
 * button still works for anything extra.
 */
export function AutoInvoiceToggle({ academy, onChanged }) {
  const [on, setOn] = useState(Boolean(academy.autoInvoice));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setOn(Boolean(academy.autoInvoice)); }, [academy.autoInvoice]);
  const linked = Boolean(academy.company && !academy.company.missing);

  const change = async (value) => {
    setOn(value);
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/crm/academies/${academy.id}/settings`, { autoInvoice: value });
      if (onChanged) onChanged(r.academy);
    } catch (err) {
      setOn(!value);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: BRAND.ink, cursor: 'pointer' }}>
        <input type="checkbox" checked={on} disabled={busy || (!linked && !on)} onChange={(e) => change(e.target.checked)} />
        Invoice automatically
      </label>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
        {!linked && !on
          ? 'Link it to a company first.'
          : on
            ? 'Each morning, anything due goes on one Xero invoice and Xero emails it to the client.'
            : 'Or turn this on to raise and email each invoice on the morning it falls due.'}
      </div>
      {error && <div role="alert" style={{ color: '#B91C1C', fontSize: 12.5, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

// "Team, billed annually, £750 set-up".
export function orderText(o) {
  const period = o.billingPeriod === 'annual' ? 'billed annually' : 'billed monthly';
  return `${o.planName || o.plan}, ${period}${o.setupFee > 0 ? `, ${formatGBP(o.setupFee)} set-up` : ''}`;
}

/**
 * Put an academy sold on a proposal onto the academy it is for, once that
 * academy exists: the server links it to the deal's company and sets the plan.
 * Academies already linked to that company come first.
 */
export function ApplyOrderModal({ order, academies, onClose, onDone }) {
  const options = useMemo(() => {
    const rank = (a) => (order.companyId && a.crmCompanyId === order.companyId ? 0 : a.crmCompanyId ? 2 : 1);
    return (academies || []).filter((a) => !a.demo)
      .sort((x, y) => rank(x) - rank(y) || String(x.name).localeCompare(String(y.name)));
  }, [academies, order.companyId]);
  const [tenantId, setTenantId] = useState(() => {
    const mine = options.filter((a) => order.companyId && a.crmCompanyId === order.companyId);
    return mine.length === 1 ? mine[0].id : '';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const chosen = options.find((a) => a.id === tenantId) || null;
  const who = order.companyName || order.dealTitle || 'the client';
  const movesCompany = Boolean(chosen?.company && order.companyId && chosen.company.id !== order.companyId);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post(`/api/crm/academies/${tenantId}/apply-order`, { orderId: order.id }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={500}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17, color: BRAND.ink }}>Set up {who}'s academy</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted }}>
        Signed: {orderText(order)}. Applying it links the academy to {who} and puts it on that plan. An academy
        still on its free trial keeps the trial, with this plan to follow.
        {order.setupFee > 0 ? ` The ${formatGBP(order.setupFee)} set-up fee is then due to invoice.` : ''}
      </p>
      {options.length ? (
        <>
          <label htmlFor="apply-order-academy" style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: BRAND.ink, marginBottom: 4 }}>Academy</label>
          <select id="apply-order-academy" className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={{ width: '100%' }}>
            <option value="">Choose an academy</option>
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.subdomain}){a.company?.name ? `, ${a.company.name}` : ''}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p style={{ fontSize: 13, color: BRAND.ink, margin: 0 }}>There are no academies yet. Create {who}'s in the staff CMS first.</p>
      )}
      {movesCompany && (
        <p style={{ fontSize: 12.5, color: '#B45309', margin: '8px 0 0' }}>
          That academy is linked to {chosen.company.name}. Applying this order links it to {who} instead.
        </p>
      )}
      {error && <p role="alert" style={{ color: '#B91C1C', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" type="button" onClick={apply} disabled={busy || !tenantId}>
          {busy ? 'Applying…' : 'Apply the order'}
        </button>
      </div>
    </Modal>
  );
}

export function CmsLink({ academy }) {
  if (!academy.cmsUrl) return null;
  return (
    <a href={academy.cmsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
      Open in CMS <ExternalLink size={11} style={{ verticalAlign: -1 }} />
    </a>
  );
}
