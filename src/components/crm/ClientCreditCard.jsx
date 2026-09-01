import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Wallet, Film, Clock3, CheckCircle2, ExternalLink } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Card, Empty } from './Card.jsx';
import { fmtCredits } from './creditDisplay.jsx';

// The CUSTOMER'S video-credit balance, on the project page — deliberately the
// same three numbers, in the same words, as their client portal:
//
//   available  what they can still spend on something new
//   reserved   minutes we've earmarked against named videos, including videos
//              that haven't started yet (that's the whole point of it)
//   used       drawn down for real, once a video was signed off
//
// This is company-wide credit (bought in the portal, or partner credit), NOT the
// deal's own credit-based project — that's the separate RetainersCard below,
// and it's called out here when a project has both so nobody adds them up twice.

export const fmtMins = (n) => `${fmtCredits(n)} min`;

export function ClientCreditCard({ dealId, companyName, onOpenVideo, onOpenCompany, companyId, refreshKey }) {
  const { actions } = useStore();
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    if (!dealId) return;
    actions.loadDealCreditSummary(dealId).then((d) => { setData(d); setLoaded(true); });
  }, [dealId, actions]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const balance = data?.balance || null;
  const allocations = data?.allocations || [];
  const creditProject = data?.creditProject || null;

  // Split by project so "what's set aside here" reads separately from "what
  // they've committed elsewhere" — a PM planning this job needs both, but not
  // muddled together.
  const { here, elsewhere } = useMemo(() => {
    const here = [], elsewhere = [];
    for (const a of allocations) (a.dealId === dealId ? here : elsewhere).push(a);
    return { here, elsewhere };
  }, [allocations, dealId]);

  if (!loaded) return <Card title="Client video credit"><Empty text="Loading…" /></Card>;

  // No customer attached, or no credit and nothing set aside — say so plainly
  // rather than showing a row of zeroes.
  const hasAnything = (balance?.issued || 0) > 0 || allocations.length > 0 || !!creditProject;
  if (!data?.companyId) {
    return (
      <Card title="Client video credit">
        <Empty text="No customer is attached to this project, so there’s no credit balance to draw on." />
      </Card>
    );
  }
  if (!hasAnything) {
    return (
      <Card title="Client video credit">
        <Empty text={`${companyName || 'This customer'} doesn’t hold any video credit. They can buy it in their portal, or you can sell it from their organisation page.`} />
      </Card>
    );
  }

  const available = balance?.available ?? balance?.remaining ?? 0;
  const reserved = balance?.reserved ?? 0;
  const used = balance?.used ?? 0;

  return (
    <Card
      title="Client video credit"
      action={companyId && onOpenCompany ? (
        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => onOpenCompany(companyId)}
          title="Open the organisation to see the full ledger">
          <ExternalLink size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Ledger
        </button>
      ) : null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 12.5, color: BRAND.muted }}>
          What <strong style={{ color: BRAND.ink }}>{companyName || 'this customer'}</strong> sees in their portal —
          {' '}the same numbers, so a producer and a client are never reading different balances.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <Figure icon={Wallet} label="Available" value={fmtMins(available)} color="#15803D" bg="#F0FDF4" border="#BBF7D0" />
          <Figure icon={Clock3} label="Reserved" value={fmtMins(reserved)} color="#B45309" bg="#FFFBEB" border="#FDE68A" />
          <Figure icon={CheckCircle2} label="Used" value={fmtMins(used)} color={BRAND.muted} bg="#F8FAFC" border={BRAND.border} />
        </div>

        {available < 0 && (
          <div style={{ fontSize: 12.5, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px' }}>
            More credit is reserved than they hold — release some from a video below, or top their balance up.
          </div>
        )}

        <AllocationList
          heading="Set aside on this project"
          rows={here}
          onOpenVideo={onOpenVideo}
          empty="Nothing from their credit is assigned to this project yet — use “Credit” on a video below."
        />

        {elsewhere.length > 0 && (
          <AllocationList
            heading="Set aside on their other projects"
            rows={elsewhere}
            onOpenVideo={onOpenVideo}
            showProject
          />
        )}

        {creditProject && (
          // A deal can have BOTH: company-wide credit and its own pre-paid pool.
          // They're different pots and are drawn down by different mechanisms,
          // so the card names the other one rather than silently ignoring it.
          <div style={{ fontSize: 12, color: BRAND.muted, borderTop: '1px solid ' + BRAND.border, paddingTop: 10 }}>
            This project also has its own credit pool of{' '}
            <strong style={{ color: BRAND.ink }}>{fmtCredits(creditProject.remaining)}</strong> remaining, assigned
            per video in <strong style={{ color: BRAND.ink }}>Credit Based Projects</strong> below. It’s a separate
            pot from the balance above.
          </div>
        )}
      </div>
    </Card>
  );
}

function Figure({ icon: Icon, label, value, color, bg, border }) {
  return (
    <div style={{ background: bg, border: '1px solid ' + border, borderRadius: 8, padding: '9px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        <Icon size={11} /> {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 800, color: BRAND.ink, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function AllocationList({ heading, rows, onOpenVideo, showProject = false, empty }) {
  if (!rows.length && !empty) return null;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        {heading}
      </div>
      {rows.length === 0 ? <Empty text={empty} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((a) => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
              background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 12.5,
            }}>
              <Film size={13} color={BRAND.muted} style={{ flexShrink: 0 }} />
              <button
                type="button"
                onClick={() => onOpenVideo && onOpenVideo(a.videoId)}
                disabled={!onOpenVideo}
                style={{
                  flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 0, padding: 0,
                  font: 'inherit', color: onOpenVideo ? BRAND.blue : BRAND.ink, cursor: onOpenVideo ? 'pointer' : 'default',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {a.videoTitle}
                {showProject && a.projectTitle ? <span style={{ color: BRAND.muted }}> · {a.projectTitle}</span> : null}
              </button>
              <CreditStatusPill allocation={a} />
              <strong style={{ color: BRAND.ink, flexShrink: 0 }}>{fmtMins(a.minutes)}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Reserved-and-not-started is the state this whole feature exists to make
// visible, so it gets its own wording rather than being lumped in with reserved.
export function CreditStatusPill({ allocation }) {
  if (!allocation) return null;
  const spent = allocation.status === 'spent';
  const label = spent ? 'Drawn down' : allocation.planned ? 'Reserved · not started' : 'Reserved';
  const color = spent ? BRAND.muted : '#B45309';
  const bg = spent ? '#F1F5F9' : '#FFFBEB';
  const border = spent ? BRAND.border : '#FDE68A';
  return (
    <span style={{
      flexShrink: 0, fontSize: 10.5, fontWeight: 700, color, background: bg,
      border: '1px solid ' + border, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}
