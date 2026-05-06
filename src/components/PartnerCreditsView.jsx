import React, { useEffect, useState } from 'react';
import { ArrowLeft, Coins } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { useIsMobile } from '../utils.js';

function fmtCredits(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function PartnerCreditsView({ onBack, onOpen }) {
  const { state, actions } = useStore();
  const [loading, setLoading] = useState(state.partnerCreditsList === null);
  const isMobile = useIsMobile();

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.fetchPartnerCreditsList().finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions]);

  const list = state.partnerCreditsList || [];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '20px 16px' : '40px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Coins size={22} color={BRAND.blue} />
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Partner Programme Credits</h1>
        </div>
      </header>

      {loading && list.length === 0 ? (
        <Card><div style={{ padding: 60, textAlign: 'center', color: BRAND.muted }}>Loading clients…</div></Card>
      ) : list.length === 0 ? (
        <Card>
          <div style={{ padding: 60, textAlign: 'center' }}>
            <Coins size={40} color={BRAND.muted} style={{ marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>No partner subscribers yet</h3>
            <p style={{ color: BRAND.muted, fontSize: 14, margin: 0 }}>
              Once a client signs up to the Partner Programme they'll appear here with their credit balance.
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid ' + BRAND.border, color: BRAND.muted, textAlign: 'left' }}>
                  <Th>Client</Th>
                  <Th align="center">Status</Th>
                  <Th align="right">Issued</Th>
                  <Th align="right">Used</Th>
                  <Th align="right">Remaining</Th>
                  {!isMobile && <Th>Usage</Th>}
                  {!isMobile && <Th>Last payment</Th>}
                </tr>
              </thead>
              <tbody>
                {list.map(row => {
                  const issued = Number(row.creditsIssued) || 0;
                  const used = Number(row.creditsUsed) || 0;
                  const pct = issued > 0 ? Math.min(100, Math.round((used / issued) * 100)) : 0;
                  return (
                    <tr
                      key={row.clientKey}
                      onClick={() => onOpen(row.clientKey)}
                      style={{ borderBottom: '1px solid ' + BRAND.border, cursor: 'pointer' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '12px 8px' }}>
                        <div style={{ fontWeight: 600 }}>{row.clientName || row.clientKey}</div>
                        <div style={{ fontSize: 11, color: BRAND.muted }}>
                          {row.subscriptions.active} active / {row.subscriptions.count} subscription{row.subscriptions.count === 1 ? '' : 's'}
                        </div>
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                        <StatusPill status={row.status} />
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(issued)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(used)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtCredits(row.creditsRemaining)}</td>
                      {!isMobile && (
                        <td style={{ padding: '12px 8px', minWidth: 160 }}>
                          <div style={{ background: BRAND.border, borderRadius: 999, height: 8, overflow: 'hidden' }}>
                            <div style={{ width: pct + '%', background: pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : BRAND.blue, height: '100%' }} />
                          </div>
                          <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>{pct}%</div>
                        </td>
                      )}
                      {!isMobile && <td style={{ padding: '12px 8px', color: BRAND.muted }}>{fmtDate(row.lastPaymentAt)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function Th({ children, align }) {
  return (
    <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: align || 'left' }}>
      {children}
    </th>
  );
}

function StatusPill({ status }) {
  const active = status === 'active';
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      background: active ? '#DCFCE7' : '#F3F4F6',
      color: active ? '#15803D' : '#6B7280',
    }}>{active ? 'Active' : 'Inactive'}</span>
  );
}

function Card({ children }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 0 }}>
      {children}
    </div>
  );
}
