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

export function ClientCreditCard({ dealId, dealTitle, companyName, onOpenVideo, onOpenCompany, companyId, refreshKey }) {
  const { actions } = useStore();
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);
  // '' = every balance added together. Only meaningful when the customer holds
  // more than one; see `pools` below. null = not yet defaulted.
  const [pool, setPool] = useState(null);

  const load = useCallback(() => {
    if (!dealId) return;
    actions.loadDealCreditSummary(dealId).then((d) => { setData(d); setLoaded(true); });
  }, [dealId, actions]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const balance = data?.balance || null;
  const allocations = data?.allocations || [];
  const creditProject = data?.creditProject || null;
  const pools = balance?.pools || [];
  const multiPool = pools.length > 1;

  // Which balance to open on. Newcastle University holds one per NHS study, and
  // the useful default on the Rivival deal is the Rivival study — so a pool
  // whose name shares a distinctive word with the project is preselected. No
  // match just falls back to the combined view.
  useEffect(() => {
    if (pool !== null || !multiPool) return;
    setPool(guessPool(pools, dealTitle) || '');
  }, [pool, multiPool, pools, dealTitle]);

  const selected = multiPool && pool ? pools.find((p) => p.clientKey === pool) || null : null;

  // Split by project so "what's set aside here" reads separately from "what
  // they've committed elsewhere" — a PM planning this job needs both, but not
  // muddled together. Narrowed to the chosen balance when there is one.
  const { here, elsewhere } = useMemo(() => {
    const here = [], elsewhere = [];
    for (const a of allocations) {
      if (selected && a.clientKey !== selected.clientKey) continue;
      (a.dealId === dealId ? here : elsewhere).push(a);
    }
    return { here, elsewhere };
  }, [allocations, dealId, selected]);

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

  // The three figures, for whichever balance is in view.
  const available = selected ? selected.available : (balance?.available ?? balance?.remaining ?? 0);
  const reserved = selected ? selected.reserved : (balance?.reserved ?? 0);
  const used = selected ? selected.used : (balance?.used ?? 0);

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

        {/* A customer can run several credit balances at once — Newcastle
            University has one per NHS study — and adding them up gives a number
            nobody can act on. Pick the one this job draws on. */}
        {multiPool && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <span style={{ fontWeight: 700, color: BRAND.ink, whiteSpace: 'nowrap' }}>Project</span>
            <select
              value={pool ?? ''}
              onChange={(e) => setPool(e.target.value)}
              style={{ flex: 1, minWidth: 0, padding: '7px 9px', fontSize: 13, border: '1px solid ' + BRAND.border, borderRadius: 8, background: 'white' }}
            >
              <option value="">All projects — {fmtMins(balance?.available ?? 0)} free of {fmtMins(balance?.issued ?? 0)}</option>
              {pools.map((p) => (
                <option key={p.clientKey} value={p.clientKey}>
                  {p.name} — {fmtMins(p.available)} free of {fmtMins(p.issued)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <Figure icon={Wallet} label="Available" value={fmtMins(available)} color="#15803D" bg="#F0FDF4" border="#BBF7D0" />
          <Figure icon={Clock3} label="Reserved" value={fmtMins(reserved)} color="#B45309" bg="#FFFBEB" border="#FDE68A" />
          <Figure icon={CheckCircle2} label="Used" value={fmtMins(used)} color={BRAND.muted} bg="#F8FAFC" border={BRAND.border} />
        </div>

        {multiPool && !selected && (
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: -6 }}>
            That’s <strong style={{ color: BRAND.ink }}>{pools.length}</strong> separate balances added together
            ({pools.map((p) => p.name).join(', ')}). Pick one above to see what that project alone has left.
          </div>
        )}

        {available < 0 && (
          <div style={{ fontSize: 12.5, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px' }}>
            More credit is reserved than they hold — release some from a video below, or top their balance up.
          </div>
        )}

        <AllocationList
          heading={selected ? `Set aside on this project, from ${selected.name}` : 'Set aside on this project'}
          rows={here}
          onOpenVideo={onOpenVideo}
          showPool={multiPool && !selected}
          empty="Nothing from their credit is assigned to this project yet — use “Credit” on a video below."
        />

        {elsewhere.length > 0 && (
          <AllocationList
            heading="Set aside on their other projects"
            rows={elsewhere}
            onOpenVideo={onOpenVideo}
            showProject
            showPool={multiPool && !selected}
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

// Which balance a project most likely belongs to. Matches on distinctive words
// shared by the pool name and the project title — "NHS Rivival Study" against
// "Rivivial x2 Sandip" — ignoring the filler every study name carries. A guess
// only: it picks the dropdown's starting value, and the PM can change it.
const POOL_STOPWORDS = new Set(['nhs', 'study', 'studies', 'the', 'and', 'video', 'videos', 'project', 'projects', 'ltd', 'limited', 'trust', 'university', 'college', 'credits', 'credit']);
// Two words describe the same thing. Containment catches "rivival" inside
// "rivivalstudy"; the shared-prefix rule catches the spelling drifting between
// systems, which it has — the deal is "Rivivial" and the credit client
// "Rivival", so neither contains the other.
const PREFIX_MATCH = 5;
function wordsAgree(a, b) {
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const n = Math.min(a.length, b.length, PREFIX_MATCH);
  return n >= PREFIX_MATCH && a.slice(0, n) === b.slice(0, n);
}

export function guessPool(pools, dealTitle) {
  const words = String(dealTitle || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
  if (!words.length) return null;
  let best = null;
  let bestScore = 0;
  for (const p of pools) {
    const poolWords = (String(p.name || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])
      .filter((w) => !POOL_STOPWORDS.has(w));
    let score = 0;
    for (const pw of poolWords) {
      if (words.some((w) => wordsAgree(w, pw))) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore > 0 ? best.clientKey : null;
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

function AllocationList({ heading, rows, onOpenVideo, showProject = false, showPool = false, empty }) {
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
              {showPool && a.poolName && (
                <span title="Which of the customer’s credit balances this draws on"
                  style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: BRAND.muted, background: '#F1F5F9', border: '1px solid ' + BRAND.border, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.poolName}
                </span>
              )}
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
