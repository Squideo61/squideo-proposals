// Video Credit — the client buys a block of production minutes now at a tiered
// discount (the Content Credit ladder) and draws it down on new videos. Shows
// their live balance and a buy panel with two payment routes: card (Stripe) or
// request an invoice. Pricing shown here is for display only; the purchase
// amount is always recomputed server-side.
import React, { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, SectionHeading, EmptyState, fmtGBP } from '../components.jsx';
import { Clapperboard, CreditCard, Film, FileText, Minus, Plus, Sparkles, Wallet } from 'lucide-react';
import { LEAD_MAGNET } from '../../lib/leadMagnet.js';

const MIN = 1;
const MAX = 120;

// Mirrors api/_lib/videoCredit.js videoCreditQuote — display only.
function quoteFor(minutes, p) {
  const m = Math.max(MIN, Math.min(MAX, Math.floor(minutes || 0)));
  const discount = Math.min(p.baseDiscount + (m - 1) * p.stepPerMin, p.maxDiscount);
  const unitExVat = p.ratePerMin * (1 - discount);
  const subtotalExVat = unitExVat * m;
  const vat = subtotalExVat * p.vatRate;
  return { m, discount, unitExVat, subtotalExVat, vat, totalIncVat: subtotalExVat + vat };
}

const fmtMins = (n) => `${Math.round((n + Number.EPSILON) * 10) / 10} min`;

export default function VideoCredit() {
  const { companyId, user, showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [minutes, setMinutes] = useState(2);
  const [busy, setBusy] = useState(null); // 'card' | 'invoice'

  // Read from the session so the "not yet" state renders on the first paint,
  // rather than flashing the page and then replacing it once a 403 comes back.
  const hidden = (user?.companies || []).find((c) => c.id === companyId)?.creditVisible === false;

  // Always ask, even when the session says hidden. The server allows a company
  // that HOLDS credit through regardless of the switch — nobody is locked out
  // of credit they've already paid for — and that exception is only knowable
  // server-side. Asking anyway is what lets it reach them.
  const load = () => {
    if (!companyId) return;
    portalApi.get(`video-credit?companyId=${encodeURIComponent(companyId)}`)
      .then((d) => { setData(d); setError(null); })
      .catch((err) => setError(err.message));
  };

  useEffect(() => { setData(null); setError(null); load(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server is the authority: if it sent a balance, show it whatever the
  // session thought. `hidden` only decides what to render while the first
  // request is still in flight, so the page doesn't flash a rate card at
  // someone who shouldn't see one.
  const refused = /available once your first project/i.test(error || '');
  const notYet = !data && (refused || hidden);

  // Handle the return from Stripe Checkout (?credit_paid / ?credit_cancelled).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('credit_paid') === '1') {
      showToast('Payment received — your video credit will appear here in a moment ✓');
      // Give the webhook a beat, then refresh the balance.
      setTimeout(load, 2500);
    } else if (params.get('credit_cancelled') === '1') {
      showToast('Payment cancelled — no credit was purchased.');
    }
    if (params.has('credit_paid') || params.has('credit_cancelled')) {
      const url = window.location.pathname + window.location.hash;
      window.history.replaceState(null, '', url);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pricing = data?.pricing || null;
  const q = useMemo(() => (pricing ? quoteFor(minutes, pricing) : null), [minutes, pricing]);
  const remaining = data?.balance?.remaining ?? 0;
  // What they can still spend on something new: the balance minus the minutes
  // our team has already set aside for named videos of theirs. Showing only the
  // total would over-promise, and showing only the free figure would look like
  // credit had gone missing — so the page shows both, and what the reserved part
  // is for.
  const available = data?.balance?.available ?? remaining;
  const reserved = data?.balance?.reserved ?? 0;
  const allocations = data?.allocations || [];
  const reservedFor = allocations.filter((a) => a.status === 'reserved');
  // Some organisations run a separate credit budget per project — a university
  // with one per study, say. When they do, one combined balance isn't the
  // number anyone needs, so we show each alongside it.
  const pools = data?.pools || [];

  const buyCard = async () => {
    setBusy('card');
    try {
      const res = await portalApi.post(`video-credit-checkout?companyId=${encodeURIComponent(companyId)}`, { minutes });
      if (res?.checkoutUrl) window.location.href = res.checkoutUrl;
      else throw new Error('Could not start payment');
    } catch (err) {
      showToast(err.message);
      setBusy(null);
    }
  };

  const buyInvoice = async () => {
    setBusy('invoice');
    try {
      await portalApi.post(`video-credit-invoice?companyId=${encodeURIComponent(companyId)}`, { minutes });
      showToast("Request sent — we'll email your invoice. Credit lands once it's paid ✓");
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(null);
    }
  };

  const step = (delta) => setMinutes((m) => Math.max(MIN, Math.min(MAX, m + delta)));

  // A prospect who deep-links here gets a 403 from the server. Answer it with
  // the actual reason rather than a red error box: credit is the rung after a
  // first project, and saying so is a nudge towards one — not a wall. Crucially
  // this renders BEFORE the rate is ever mentioned.
  if (notYet) {
    return (
      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        <Card>
          <EmptyState
            icon={<Wallet size={34} />}
            title="Video credit comes a little later"
            body="Once your first video is under way we'll open this up — you can buy production time in a block at a discount and spend it on everything after that. It works best when there's a style to repeat, so the first one comes first."
            action={
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <a className="btn" href="#/brief">Start a brief</a>
                <a className="btn-ghost" href="#/course">Watch {LEAD_MAGNET.shortNoun}</a>
              </div>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: BRAND.ink }}>Video credit</h1>
        <p style={{ margin: '6px 0 0', fontSize: 14, color: BRAND.muted, lineHeight: 1.5 }}>
          Buy a block of production minutes now at a bulk discount, then spend it on any new video whenever you're ready.
        </p>
      </div>

      {/* Balance */}
      <Card style={{ background: 'linear-gradient(120deg, #0F2A3D, #14405e)', color: '#fff', border: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'rgba(255,255,255,0.12)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Wallet size={24} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: '#B9CBD6', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Your credit balance</div>
            {data ? (
              <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1 }}>{fmtMins(remaining)}</div>
            ) : (
              <div style={{ fontSize: 15, color: '#B9CBD6' }}>{error ? '—' : 'Loading…'}</div>
            )}
          </div>
          {data && (data.balance.used > 0 || data.balance.issued > 0) && (
            <div style={{ textAlign: 'right', fontSize: 12, color: '#B9CBD6', flexShrink: 0 }}>
              <div>{fmtMins(data.balance.issued)} bought</div>
              {reserved > 0 && <div>{fmtMins(reserved)} reserved</div>}
              <div>{fmtMins(data.balance.used)} used</div>
            </div>
          )}
        </div>

        {/* Reserved minutes, and the videos they're held for. Without this the
            "free to spend" figure below would just look like the balance had
            quietly shrunk. */}
        {reserved > 0 && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.14)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#B9CBD6' }}>
                <strong style={{ color: '#fff' }}>{fmtMins(reserved)}</strong> is set aside for videos we've planned with you
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: '#7EE2A8' }}>
                {fmtMins(available)} free to spend
              </span>
            </div>
            {reservedFor.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                {reservedFor.map((a) => (
                  <div key={a.videoId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#DDE9F0' }}>
                    <Film size={13} style={{ flexShrink: 0, opacity: 0.8 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.videoTitle}
                      {a.projectTitle && a.projectTitle !== a.videoTitle ? <span style={{ color: '#8FA9B8' }}> · {a.projectTitle}</span> : null}
                    </span>
                    {a.poolName && pools.length > 0 && (
                      <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: '#B9CBD6', border: '1px solid rgba(185,203,214,0.35)', borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.poolName}
                      </span>
                    )}
                    {a.planned && (
                      <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: '#FDE68A', border: '1px solid rgba(253,230,138,0.4)', borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' }}>
                        Not started
                      </span>
                    )}
                    <strong style={{ flexShrink: 0, color: '#fff' }}>{fmtMins(a.minutes)}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Per-project balances, for an organisation that budgets credit per
          project rather than as one pot. */}
      {pools.length > 0 && (
        <Card>
          <SectionHeading>Your credit by project</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pools.map((p) => (
              <div key={p.name} style={{ border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 14, color: BRAND.ink }}>{p.name}</strong>
                  <span style={{ fontSize: 14, fontWeight: 800, color: '#16A34A' }}>{fmtMins(p.available)} free</span>
                </div>
                <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 3 }}>
                  {fmtMins(p.issued)} bought
                  {p.reserved > 0 ? ` · ${fmtMins(p.reserved)} set aside` : ''}
                  {p.used > 0 ? ` · ${fmtMins(p.used)} used` : ''}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {error && <Card><EmptyState title="Couldn't load your credit" body={error} /></Card>}

      {/* Buy */}
      {pricing && (
        <Card>
          <SectionHeading>Order more video credit</SectionHeading>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
            {fmtGBP(pricing.ratePerMin)}/min standard — the more minutes you buy, the bigger the discount
            (up to {Math.round(pricing.maxDiscount * 100)}% off). Credit is valid for 2 years.
          </p>

          {/* Minutes stepper */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, margin: '4px 0 16px' }}>
            <button className="btn-ghost" onClick={() => step(-1)} disabled={minutes <= MIN}
              style={{ width: 42, height: 42, borderRadius: 12, border: `1px solid ${BRAND.border}`, display: 'grid', placeItems: 'center' }}>
              <Minus size={18} />
            </button>
            <div style={{ textAlign: 'center', minWidth: 96 }}>
              <div style={{ fontSize: 34, fontWeight: 800, color: BRAND.ink, lineHeight: 1 }}>{minutes}</div>
              <div style={{ fontSize: 12, color: BRAND.muted, fontWeight: 600 }}>minute{minutes === 1 ? '' : 's'}</div>
            </div>
            <button className="btn-ghost" onClick={() => step(1)} disabled={minutes >= MAX}
              style={{ width: 42, height: 42, borderRadius: 12, border: `1px solid ${BRAND.border}`, display: 'grid', placeItems: 'center' }}>
              <Plus size={18} />
            </button>
          </div>

          {/* Live price breakdown */}
          {q && (
            <div style={{ background: '#F7FAFC', border: `1px solid ${BRAND.border}`, borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13.5 }}>
              <Row label={`${minutes} min × ${fmtGBP(pricing.ratePerMin)}`} value={fmtGBP(pricing.ratePerMin * minutes)} muted strike />
              <Row
                label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#16A34A', fontWeight: 700 }}><Sparkles size={13} /> {Math.round(q.discount * 100)}% credit discount</span>}
                value={<span style={{ color: '#16A34A', fontWeight: 700 }}>−{fmtGBP(pricing.ratePerMin * minutes - q.subtotalExVat)}</span>}
              />
              <Row label="Subtotal (ex VAT)" value={fmtGBP(q.subtotalExVat)} />
              <Row label={`VAT (${Math.round(pricing.vatRate * 100)}%)`} value={fmtGBP(q.vat)} muted />
              <div style={{ borderTop: `1px solid ${BRAND.border}`, margin: '2px 0' }} />
              <Row label={<strong style={{ color: BRAND.ink }}>Total</strong>} value={<strong style={{ color: BRAND.ink, fontSize: 16 }}>{fmtGBP(q.totalIncVat)} inc VAT</strong>} />
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
            <button className="btn" onClick={buyCard} disabled={!!busy}
              style={{ flex: 1, minWidth: 190, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 0', fontSize: 14.5 }}>
              <CreditCard size={16} /> {busy === 'card' ? 'Starting…' : 'Pay by card'}
            </button>
            <button className="btn-ghost" onClick={buyInvoice} disabled={!!busy}
              style={{ flex: 1, minWidth: 190, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 0', fontSize: 14, fontWeight: 700, border: `1px solid ${BRAND.border}`, borderRadius: 10, color: BRAND.ink }}>
              <FileText size={16} /> {busy === 'invoice' ? 'Sending…' : 'Request an invoice'}
            </button>
          </div>
        </Card>
      )}

      {/* How it works */}
      <Card>
        <SectionHeading>How video credit works</SectionHeading>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13.5, color: BRAND.ink, lineHeight: 1.7 }}>
          <li>Credit is measured in <strong>minutes of finished video</strong> — a 2 minute video uses 2 credits.</li>
          <li>The more minutes you buy at once, the bigger the discount on them.</li>
          <li>When you request a <strong>New video</strong>, tick “use my credit” and we'll draw it down against your quote.</li>
          <li>When we plan a video with you we <strong>set credit aside</strong> for it — it stays yours, and only comes off the balance once that video is signed off.</li>
          <li>Any credit you don't use stays on your balance for up to 2 years.</li>
        </ul>
        <a href="#/request" className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13.5, fontWeight: 700, color: BRAND.blue }}>
          <Clapperboard size={15} /> Request a new video
        </a>
      </Card>
    </div>
  );
}

function Row({ label, value, muted, strike }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: muted ? BRAND.muted : BRAND.ink }}>
      <span style={strike ? { textDecoration: 'line-through' } : undefined}>{label}</span>
      <span style={strike ? { textDecoration: 'line-through' } : undefined}>{value}</span>
    </div>
  );
}
