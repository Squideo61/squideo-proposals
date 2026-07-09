import React, { useEffect, useMemo, useState } from 'react';
import { Percent, Coins, UserPlus, Trash2, ChevronDown, ChevronRight, Check, X, Pencil } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';

// Last `n` months as 'YYYY-MM' keys, newest first (mirrors the Cash Flow picker).
function recentMonths(n = 24) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const monthLabelLong = (k) => {
  const [y, m] = k.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
};
const monthLabelShort = (k) => {
  if (!k) return '';
  const [y, m] = k.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' });
};
const fmtPct = (frac) => {
  const n = (Number(frac) || 0) * 100;
  return (Math.round(n * 100) / 100) + '%';
};
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

const CARD = { background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 18, marginBottom: 16 };

// Admin → Staff Commission. Managers (commission.manage) see everyone, edit the
// bands and toggle staff on/off; on-plan staff (commission.view_own) see only
// their own figures — the server scopes the response, this just adapts the UI.
export function StaffCommissionTab() {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [month, setMonth] = useState(() => recentMonths(1)[0]);
  const [loading, setLoading] = useState(true);

  const reload = () => { setLoading(true); return actions.loadCommission(month).finally(() => setLoading(false)); };
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [month]);

  const data = state.commission && state.commission.month === month ? state.commission : null;
  const canManage = !!(data && data.canManage);

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Percent size={18} color="#0891B2" /> Staff Commission
        </h2>
        <select value={month} onChange={(e) => setMonth(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', fontSize: 14, color: BRAND.ink }}>
          {recentMonths(24).map((k) => <option key={k} value={k}>{monthLabelLong(k)}</option>)}
        </select>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        Commission is calculated automatically from cash received (ex-VAT) on each salesperson's deals — including
        extras added to a sale — and resets to £0 at the start of every month. It feeds the Cash Flow "Staff Commission"
        cost line for {monthLabelLong(month)}.
      </p>

      {!data ? (
        <div style={{ color: BRAND.muted, fontSize: 14 }}>{loading ? 'Loading…' : 'No commission data.'}</div>
      ) : (
        <>
          {canManage && <BandConfigCard config={data.config} actions={actions} showMsg={showMsg} reload={reload} />}
          {canManage && <MembersCard members={data.members} candidates={data.candidates || []} actions={actions} showMsg={showMsg} reload={reload} />}

          <div style={CARD}>
            <h3 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
              {canManage ? 'Commission this month' : 'Your commission'} — {monthLabelShort(month)}
            </h3>
            {data.members.length === 0 ? (
              <div style={{ color: BRAND.muted, fontSize: 14, padding: '8px 0' }}>
                {canManage ? 'No staff are on the commission plan yet — add someone above.' : 'You are not on the commission plan.'}
              </div>
            ) : (
              <>
                {data.members.map((m) => <MemberResult key={m.email} m={m} isMobile={isMobile} />)}
                {canManage && data.members.length > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 4px 2px', borderTop: '2px solid ' + BRAND.border, marginTop: 6, fontWeight: 700 }}>
                    <span>Total commission ({monthLabelShort(month)})</span>
                    <span style={{ color: '#0891B2' }}>{formatGBP(data.total)}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Editable band config. Percentages are entered as whole numbers (5 = 5%); the
// server accepts either a fraction or a percent.
function BandConfigCard({ config, actions, showMsg, reload }) {
  const toStr = (frac) => String(Math.round((frac || 0) * 10000) / 100);
  const [editing, setEditing] = useState(false);
  const [rateA, setRateA] = useState(toStr(config.bandARate));
  const [cap, setCap] = useState(String(config.bandACap ?? 0));
  const [rateB, setRateB] = useState(toStr(config.bandBRate));
  const [saving, setSaving] = useState(false);

  // Reset the inputs to the saved config (used on load, cancel and after save).
  const syncFromConfig = () => {
    setRateA(toStr(config.bandARate));
    setCap(String(config.bandACap ?? 0));
    setRateB(toStr(config.bandBRate));
  };
  // Re-sync when the loaded config changes — but not mid-edit, so we don't stomp
  // the values the user is typing.
  useEffect(() => { if (!editing) syncFromConfig(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [config.bandARate, config.bandACap, config.bandBRate]);

  const maxA = (parseFloat(cap) || 0) * ((parseFloat(rateA) || 0) / 100);
  const cancel = () => { syncFromConfig(); setEditing(false); };
  const save = () => {
    setSaving(true);
    // Send explicit fractions (5% → 0.05) so there's no percent/fraction ambiguity.
    actions.updateCommissionConfig({ bandARate: (parseFloat(rateA) || 0) / 100, bandACap: parseFloat(cap) || 0, bandBRate: (parseFloat(rateB) || 0) / 100 })
      .then(() => { showMsg('Commission bands saved'); setEditing(false); return reload(); })
      .finally(() => setSaving(false));
  };

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Coins size={14} color="#CA8A04" /> Commission bands
        </h3>
        {!editing && (
          <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>
        )}
      </div>

      {editing ? (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Band A rate" suffix="%">
            <input autoFocus type="number" step="0.1" min="0" value={rateA} onChange={(e) => setRateA(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="up to (net sales)" prefix="£">
            <input type="number" step="100" min="0" value={cap} onChange={(e) => setCap(e.target.value)} style={{ ...inputStyle, width: 110 }} />
          </Field>
          <Field label="Band B rate (thereafter)" suffix="%">
            <input type="number" step="0.1" min="0" value={rateB} onChange={(e) => setRateB(e.target.value)} style={inputStyle} />
          </Field>
          <button onClick={save} disabled={saving} className="btn" style={{ height: 36 }}>{saving ? 'Saving…' : 'Save bands'}</button>
          <button onClick={cancel} disabled={saving} className="btn-ghost" style={{ height: 36 }}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <ReadStat label="Band A rate" value={fmtPct(config.bandARate)} />
          <ReadStat label="up to (net sales)" value={formatGBP(config.bandACap)} />
          <ReadStat label="Band B rate (thereafter)" value={fmtPct(config.bandBRate)} />
        </div>
      )}

      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 12, lineHeight: 1.5 }}>
        Band A pays {fmtPct((parseFloat(rateA) || 0) / 100)} on the first {formatGBP(parseFloat(cap) || 0)} of net sales
        (max <strong>{formatGBP(maxA)}</strong>), then Band B pays {fmtPct((parseFloat(rateB) || 0) / 100)} on everything above — uncapped.
        {config.updatedBy ? ` · Last edited by ${config.updatedBy.split('@')[0]}.` : ''}
      </div>
    </div>
  );
}

function ReadStat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: BRAND.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: BRAND.ink, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function MembersCard({ members, candidates, actions, showMsg, reload }) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  const add = () => {
    if (!pick) return;
    setBusy(true);
    actions.addCommissionMember(pick)
      .then(() => { showMsg('Added to the commission plan'); setPick(''); setAdding(false); return reload(); })
      .finally(() => setBusy(false));
  };
  const toggle = (m) => actions.updateCommissionMember(m.email, { enabled: !m.enabled }).then(reload);
  const setFrom = (m, val) => actions.updateCommissionMember(m.email, { effectiveFrom: val }).then(reload);
  const remove = (m) => {
    if (!window.confirm(`Remove ${m.name || m.email} from the commission plan?\n\nTheir past commission stops being calculated.`)) return;
    actions.removeCommissionMember(m.email).then(() => { showMsg('Removed from the plan'); return reload(); });
  };

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>Staff on the plan</h3>
        <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => setAdding(true)} disabled={candidates.length === 0}>
          <UserPlus size={13} /> Add staff
        </button>
      </div>

      {members.length === 0 ? (
        <div style={{ color: BRAND.muted, fontSize: 14, padding: '4px 0' }}>Nobody yet. Add a salesperson to start calculating their commission.</div>
      ) : (
        members.map((m) => (
          <div key={m.email} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid ' + BRAND.border, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>{m.name || m.email}</div>
              <div style={{ fontSize: 12, color: BRAND.muted }}>{m.email}</div>
            </div>
            <label style={{ fontSize: 12, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
              From
              <input type="month" value={m.effectiveFrom} onChange={(e) => setFrom(m, e.target.value)}
                style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
            </label>
            <button onClick={() => toggle(m)} title={m.enabled ? 'On the plan — click to pause' : 'Paused — click to resume'}
              style={{ cursor: 'pointer', border: '1px solid ' + (m.enabled ? '#0891B2' : BRAND.border), background: m.enabled ? '#0891B2' : 'white', color: m.enabled ? 'white' : BRAND.muted, borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 700 }}>
              {m.enabled ? 'On' : 'Off'}
            </button>
            <button className="btn-icon" title="Remove from plan" onClick={() => remove(m)} style={{ padding: 4 }}><Trash2 size={14} /></button>
          </div>
        ))
      )}

      {adding && (
        <Modal onClose={() => setAdding(false)} maxWidth={420}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>Add staff to the commission plan</h3>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: BRAND.muted }}>
            Commission is backdated to the start of the chosen month. New members start this month.
          </p>
          <select value={pick} onChange={(e) => setPick(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, fontSize: 14, marginBottom: 14 }}>
            <option value="">Choose a person…</option>
            {candidates.map((c) => <option key={c.email} value={c.email}>{c.name || c.email}</option>)}
          </select>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" onClick={add} disabled={!pick || busy}>{busy ? 'Adding…' : 'Add to plan'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function MemberResult({ m, isMobile }) {
  const [open, setOpen] = useState(false);
  const inactive = !m.active;
  return (
    <div style={{ borderTop: '1px solid ' + BRAND.border, padding: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setOpen((v) => !v)} disabled={!m.sales.length}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: m.sales.length ? 'pointer' : 'default', padding: 0, flex: 1, minWidth: 160, textAlign: 'left' }}>
          {m.sales.length ? (open ? <ChevronDown size={16} color={BRAND.muted} /> : <ChevronRight size={16} color={BRAND.muted} />) : <span style={{ width: 16 }} />}
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>{m.name || m.email}</div>
            <div style={{ fontSize: 12, color: BRAND.muted }}>
              {inactive
                ? (m.enabled ? `Joins ${monthLabelShort(m.effectiveFrom)}` : 'Paused')
                : `${m.sales.length} payment${m.sales.length === 1 ? '' : 's'} · ${formatGBP(m.qualifyingNet)} net qualifying`}
            </div>
          </div>
        </button>
        <div style={{ display: 'flex', gap: isMobile ? 12 : 24, alignItems: 'center' }}>
          <Stat label="Band A" value={formatGBP(m.commission.bandA)} />
          <Stat label="Band B" value={formatGBP(m.commission.bandB)} />
          <Stat label="Commission" value={formatGBP(m.commission.total)} accent />
        </div>
      </div>

      {open && m.sales.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: BRAND.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Company</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Deal</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>Paid</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>Net counted</th>
              </tr>
            </thead>
            <tbody>
              {m.sales.map((s, i) => (
                <tr key={i} style={{ borderTop: '1px solid ' + BRAND.border }}>
                  <td style={{ padding: '6px 8px' }}>{s.company || '—'}</td>
                  <td style={{ padding: '6px 8px', color: BRAND.muted }}>{s.title || '—'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: BRAND.muted, whiteSpace: 'nowrap' }}>{fmtDate(s.paidAt)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{formatGBP(s.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 10, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: accent ? '#0891B2' : BRAND.ink }}>{value}</div>
    </div>
  );
}

function Field({ label, prefix, suffix, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: BRAND.muted, fontWeight: 600 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {prefix && <span style={{ color: BRAND.muted }}>{prefix}</span>}
        {children}
        {suffix && <span style={{ color: BRAND.muted }}>{suffix}</span>}
      </span>
    </label>
  );
}

const inputStyle = { width: 80, padding: '6px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14 };
