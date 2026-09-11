// Academies — every Squideo Academy, as a subscription the CRM looks after.
//
// Plans, trials, usage and the statement for extra people come from the
// academy platform over its private API; the company, the invoices and the
// alerts are the CRM's. The top line answers "what is this worth and what needs
// doing": recurring revenue, trials ending, money waiting to be invoiced and
// plans asked for. A plan is set up in the staff CMS, one click away on every
// academy, or by a signed proposal: an academy sold on one that did not name the
// academy waits at the top of the page until it is applied to it.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { GraduationCap, RefreshCw } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { formatGBP, useIsMobile } from '../../utils.js';
import { Modal, ResponsiveTable } from '../ui.jsx';
import { AcademyPanel } from './AcademyPanel.jsx';
import {
  AcademyInvoiceModal, ApplyOrderModal, FlagChips, LinkCompanyModal, datesText, fmtDay, orderText, planText,
  usageText, valueText,
} from './academyUi.jsx';

const FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'attention', label: 'Needs attention', test: (a) => (a.flags || []).length > 0 },
  { key: 'paying', label: 'Paying', test: (a) => a.billed },
  { key: 'trials', label: 'On a trial', test: (a) => a.summary?.trial?.phase && a.summary.trial.phase !== 'none' },
  { key: 'unlinked', label: 'Not linked', test: (a) => !a.company && !a.demo },
];

function Tile({ label, value, sub }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ fontSize: 11.5, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: BRAND.ink, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function AcademiesView({ onOpenCompany }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  const [detailId, setDetailId] = useState(null);
  const [invoicing, setInvoicing] = useState(null);
  const [linking, setLinking] = useState(null);
  const [applying, setApplying] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api.get('/api/crm/academies'));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const academies = data?.academies || [];
  const totals = data?.totals || null;
  const waiting = data?.orders || [];
  const shown = useMemo(() => {
    const test = (FILTERS.find((f) => f.key === filter) || FILTERS[0]).test;
    return academies.filter(test);
  }, [academies, filter]);
  const detail = academies.find((a) => a.id === detailId) || null;

  // After an invoice or a link, the whole list reloads: totals, flags and the
  // Predicted-payments picture all move together.
  const changed = () => { setInvoicing(null); setLinking(null); setApplying(null); load(); };
  const unmark = async (row) => {
    try {
      await api.post(`/api/crm/academies/${detailId}/unmark`, { rowId: row.id });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const columns = [
    {
      key: 'name',
      label: 'Academy',
      render: (a) => (
        <span>
          <strong>{a.name}</strong>
          {a.demo && <span style={{ fontSize: 10.5, fontWeight: 700, color: BRAND.muted, marginLeft: 6 }}>DEMO</span>}
          <div style={{ fontSize: 12, color: BRAND.muted }}>{a.subdomain}</div>
        </span>
      ),
    },
    {
      key: 'company',
      label: 'Company',
      render: (a) => (a.company
        ? <span style={{ color: a.company.missing ? '#B91C1C' : BRAND.ink }}>{a.company.name || 'Missing company'}</span>
        : <span style={{ color: BRAND.muted }}>{a.demo ? 'Demo' : 'Not linked'}</span>),
    },
    {
      key: 'plan',
      label: 'Plan',
      render: (a) => (
        <span>
          {planText(a)}
          <div style={{ fontSize: 12, color: BRAND.muted }}>{valueText(a)}</div>
        </span>
      ),
    },
    {
      key: 'learners',
      label: 'Learners',
      hideOnMobile: false,
      render: (a) => (
        <span style={{ color: a.summary?.check?.status === 'over' ? '#B91C1C' : BRAND.ink, fontVariantNumeric: 'tabular-nums' }}>
          {usageText(a)}
        </span>
      ),
    },
    { key: 'dates', label: 'Trial / renewal', hideOnMobile: true, render: (a) => datesText(a) || '—' },
    { key: 'flags', label: 'Needs', render: (a) => <FlagChips flags={a.flags} /> },
  ];

  return (
    <div style={{ padding: isMobile ? '16px 12px 80px' : '20px 24px 60px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: BRAND.ink }}>
          <GraduationCap size={19} style={{ verticalAlign: -3, marginRight: 8, color: BRAND.blue }} />
          Academies
        </h1>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={load} disabled={busy} style={{ fontSize: 12 }}>
          <RefreshCw size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Refresh
        </button>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted }}>
        Squideo Academy subscriptions. Plans, trials and usage come from the academy platform; set a plan up
        in the staff CMS or from a signed proposal, and invoice it here.
      </p>

      {error && (
        <div role="alert" style={{ border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {totals && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(5, minmax(0, 1fr))', gap: 10, marginBottom: 16 }}>
          <Tile label="Monthly recurring" value={formatGBP(totals.mrr)} sub={`${formatGBP(totals.arr)} a year`} />
          <Tile label="Paying academies" value={totals.paying} />
          <Tile label="On a trial" value={totals.trials} sub={`${totals.trialsEndingThisMonth} ending this month`} />
          <Tile label="To invoice" value={formatGBP(totals.toInvoice)} sub={`${totals.toInvoiceCount} ${totals.toInvoiceCount === 1 ? 'academy' : 'academies'}, ex VAT`} />
          <Tile label="Plans asked for" value={totals.requests} />
        </div>
      )}

      {waiting.length > 0 && (
        <div style={{ border: '1px solid #BFDBFE', background: '#EFF6FF', borderRadius: 10, padding: '10px 12px', marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, color: '#1D4ED8' }}>Sold, waiting to be set up</strong>
          <p style={{ margin: '2px 0 6px', fontSize: 12.5, color: BRAND.muted }}>
            Signed on a proposal, and not on an academy yet. Create the academy in the staff CMS if it is new, then
            apply the order: that links it to the company and puts it on the plan.
          </p>
          {waiting.map((o) => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, padding: '7px 0', borderTop: '1px solid #DBEAFE' }}>
              <span style={{ flex: 1, minWidth: 220 }}>
                <strong>{o.companyName || o.dealTitle || 'A client'}</strong>: {orderText(o)}
                <div style={{ fontSize: 12, color: BRAND.muted }}>
                  Signed {fmtDay(o.createdAt)}{o.signerName ? ` by ${o.signerName}` : ''}
                  {o.dealId && <> · <a href={`#/deal/${o.dealId}`}>Deal</a></>}
                </div>
              </span>
              {data?.canLink && (
                <button className="btn" style={{ fontSize: 12.5 }} onClick={() => setApplying(o)}>Apply to an academy</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const count = academies.filter(f.test).length;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} className={filter === f.key ? 'btn' : 'btn-ghost'} style={{ fontSize: 12.5 }}>
              {f.label}{data ? ` · ${count}` : ''}
            </button>
          );
        })}
      </div>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: isMobile ? 0 : 4 }}>
        {!data && !error ? (
          <div style={{ padding: 24, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>Loading…</div>
        ) : (
          <ResponsiveTable
            columns={columns}
            rows={shown}
            onRowClick={(a) => setDetailId(a.id)}
            empty={filter === 'all' ? 'No academies yet.' : 'None here.'}
          />
        )}
      </div>

      {detail && !invoicing && !linking && !applying && (
        <Modal onClose={() => setDetailId(null)} maxWidth={720}>
          <AcademyPanel
            academy={detail}
            canInvoice={data?.canInvoice}
            canLink={data?.canLink}
            onInvoice={setInvoicing}
            onLink={setLinking}
            onUnmark={unmark}
            onChanged={load}
            onOpenCompany={onOpenCompany ? (id) => { setDetailId(null); onOpenCompany(id); } : null}
          />
        </Modal>
      )}
      {invoicing && (
        <AcademyInvoiceModal academy={invoicing} onClose={() => setInvoicing(null)} onDone={changed} />
      )}
      {linking && (
        <LinkCompanyModal academy={linking} onClose={() => setLinking(null)} onDone={changed} />
      )}
      {applying && (
        <ApplyOrderModal order={applying} academies={academies} onClose={() => setApplying(null)} onDone={changed} />
      )}
    </div>
  );
}
