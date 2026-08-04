// "Video credit" access, controlled from wherever you happen to be — the deal,
// the organisation or the contact. All three write to the same place, because
// credit is company-scoped: the ledger, the balance and the portal page all
// belong to the organisation, not to one deal.
//
// The default is the commercial position: credit is the rung after a first
// project, so a prospect doesn't see £/min. This is the override for the two
// cases where that's wrong — NHS and framework buyers who need their balance
// visible from day one, and clients we'd rather quote per project.

import React, { useCallback, useEffect, useState } from 'react';
import { Wallet, Check, X, Loader2, Info } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';
import { permissionsInclude } from '../../lib/permissions.js';
import { formatGBP } from '../../utils.js';
import { Card } from './Card.jsx';

export function CreditAccessCard({ companyId, compact = false }) {
  const { state, showMsg } = useStore();
  const canManage = permissionsInclude(state.me?.permissions, 'finance.manage');
  const [info, setInfo] = useState(null);
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const d = await api.get(`/api/crm/companies/${encodeURIComponent(companyId)}/credit-access`);
      setInfo(d);
      setRate(d.rateOverride != null ? String(d.rateOverride) : '');
    } catch (err) { showMsg(err.message, 'error'); }
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const save = async (enabled, ratePerMin) => {
    setBusy(true);
    try {
      const d = await api.post(
        `/api/crm/companies/${encodeURIComponent(companyId)}/credit-access`,
        { enabled, ratePerMin: ratePerMin === '' ? null : Number(ratePerMin) },
      );
      setInfo(d);
      setRate(d.rateOverride != null ? String(d.rateOverride) : '');
      showMsg(d.visible ? 'Video credit is now visible in their portal' : 'Video credit hidden from their portal');
    } catch (err) {
      showMsg(err.message, 'error');
    } finally { setBusy(false); }
  };

  if (!info) return null;
  if (!canManage && !compact) return null;

  const on = info.visible;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Wallet size={15} color={BRAND.blue} />
        <span style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>Video credit</span>
        <span style={{
          marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4,
          textTransform: 'uppercase', padding: '2px 7px', borderRadius: 4,
          background: on ? '#16A34A22' : '#6B778522',
          color: on ? '#15803D' : '#6B7785',
        }}>
          {on ? 'Visible in portal' : 'Hidden'}
        </span>
      </div>

      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.55 }}>
        {info.label?.why}
        {info.changedBy && info.creditEnabled !== null && (
          <> · set by {info.changedBy}</>
        )}
      </p>

      {canManage ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button
              className={on ? 'btn-ghost' : 'btn'}
              disabled={busy}
              onClick={() => save(on ? false : true, rate)}
              style={{ fontSize: 13 }}
            >
              {busy ? <Loader2 size={14} className="spin" /> : on ? <X size={14} /> : <Check size={14} />}
              {on ? 'Turn off for this client' : 'Enable video credit'}
            </button>
            {/* Back to the default rule, which is different from "no": it means
                nobody has decided, so the prospect/client rule applies again. */}
            {info.creditEnabled !== null && (
              <button className="btn-ghost" disabled={busy} onClick={() => save(null, rate)} style={{ fontSize: 13 }}>
                Use the default
              </button>
            )}
          </div>

          <label style={{ fontSize: 12, color: BRAND.muted, display: 'block' }}>
            Rate per minute (ex VAT)
            <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input"
                inputMode="decimal"
                value={rate}
                placeholder={String(info.suggestedRate ?? '')}
                onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ''))}
                onBlur={() => {
                  const next = rate === '' ? null : Number(rate);
                  if ((info.rateOverride ?? null) !== next) save(info.creditEnabled, rate);
                }}
                style={{ width: 120 }}
              />
              {rate === '' && (
                <button
                  type="button" className="btn-ghost" disabled={busy}
                  onClick={() => { setRate(String(info.suggestedRate)); save(info.creditEnabled, info.suggestedRate); }}
                  style={{ fontSize: 12 }}
                >
                  Use {formatGBP(info.suggestedRate)} — {info.suggestedRateSource}
                </button>
              )}
            </div>
          </label>

          <div style={{
            display: 'flex', gap: 7, marginTop: 12, padding: '9px 11px', borderRadius: 8,
            background: BRAND.paper, fontSize: 12, color: BRAND.muted, lineHeight: 1.5,
          }}>
            <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              They'll be quoted <strong style={{ color: BRAND.ink }}>{formatGBP(info.ratePerMin)}/min</strong>
              {' '}before the bulk discount
              {info.rateSource === 'company' ? ' (set here)'
                : info.rateSource === 'proposal' ? ' (from their last proposal)'
                : ' (workspace default)'}.
              {' '}Blank the box to follow {info.suggestedRateSource} automatically.
            </div>
          </div>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: 12.5, color: BRAND.muted }}>
          {formatGBP(info.ratePerMin)}/min before the bulk discount.
        </p>
      )}
    </Card>
  );
}
