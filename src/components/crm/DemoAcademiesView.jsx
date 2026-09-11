// Sales → Demos: every demo academy built for a prospect, grouped by what it
// shows off (inductions, consent, training), with who has opened it and what
// they did.
//
// The demos themselves, their logins and their visits live on the academy
// platform and come over its private API; the CRM adds the deal each one is
// for. When a prospect signs in, the platform tells the CRM, which raises the
// "Demo academy opened" alert (eye bell) and notes it on the linked deal.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, Copy, ExternalLink, History, Link2, MonitorPlay, RefreshCw } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { DealSearchPicker } from './DealSearchPicker.jsx';
import {
  DEMO_TYPES, DEMO_TYPE_LABELS, groupDemos, lastSeenText, loginsText, roleLabel,
} from '../../../api/_lib/crm/demoAcademyRules.js';

const FILTERS = [{ key: 'all', label: 'All' }, ...DEMO_TYPES.map((t) => ({ key: t, label: DEMO_TYPE_LABELS[t] }))];

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
});
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

function useCopy() {
  const [copied, setCopied] = useState(null);
  const copy = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    } catch {
      window.prompt('Copy this:', text);
    }
  };
  return { copied, copy };
}

function Logo({ demo, size = 30 }) {
  const src = demo.logoUrl || demo.faviconUrl;
  if (src) {
    return <img src={src} alt="" style={{ height: size, maxWidth: size * 4, objectFit: 'contain', display: 'block' }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: 8, background: BRAND.blue, color: 'white', display: 'grid', placeItems: 'center', fontWeight: 800 }}>
      {String(demo.name || '?').charAt(0)}
    </div>
  );
}

function DemoCard({ demo, canManage, onOpen, onLink, onChanged, setError }) {
  const { copied, copy } = useCopy();
  const [busy, setBusy] = useState(false);

  const save = async (body) => {
    setBusy(true);
    try {
      const r = await api.post(`/api/crm/demo-academies/${demo.id}/settings`, body);
      onChanged(r.demo);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <Logo demo={demo} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, color: BRAND.ink, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{demo.name}</div>
          <a href={demo.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: BRAND.muted }}>{String(demo.url || '').replace(/^https:\/\//, '')}</a>
        </div>
      </div>

      <div style={{ fontSize: 13, color: demo.lastVisit ? BRAND.ink : BRAND.muted }}>
        {lastSeenText(demo)}
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
          {demo.visits30d === 1 ? '1 visit' : `${demo.visits30d || 0} visits`} in the last 30 days
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: BRAND.muted }}>
        Deal:{' '}
        {demo.deal
          ? (demo.deal.missing
            ? <span style={{ color: '#B91C1C' }}>no longer in the CRM</span>
            : <a href={`#/deal/${demo.deal.id}`}>{demo.deal.title}</a>)
          : 'not linked'}
        {canManage && (
          <button className="btn-ghost" onClick={() => onLink(demo)} style={{ fontSize: 12, marginLeft: 6, padding: '2px 8px' }}>
            <Link2 size={12} style={{ verticalAlign: -2, marginRight: 3 }} />{demo.deal ? 'Change' : 'Link a deal'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <a className="btn" href={demo.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, textDecoration: 'none' }}>
          <ExternalLink size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Open
        </a>
        <button className="btn-ghost" onClick={() => copy('logins', loginsText(demo))} style={{ fontSize: 12.5 }} disabled={!demo.logins?.length}>
          <Copy size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{copied === 'logins' ? 'Copied' : 'Copy logins'}
        </button>
        <button className="btn-ghost" onClick={() => onOpen(demo)} style={{ fontSize: 12.5 }}>
          <History size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Visits
        </button>
      </div>

      {canManage && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid ' + BRAND.border, paddingTop: 10 }}>
          <select
            value={demo.demoType || ''}
            disabled={busy}
            onChange={(e) => save({ demoType: e.target.value || null })}
            aria-label="Demo type"
            style={{ fontSize: 12.5, padding: '4px 6px', borderRadius: 6, border: '1px solid ' + BRAND.border }}
          >
            <option value="">No type</option>
            {DEMO_TYPES.map((t) => <option key={t} value={t}>{DEMO_TYPE_LABELS[t]}</option>)}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: BRAND.ink, cursor: 'pointer' }}>
            <input type="checkbox" checked={Boolean(demo.notifyOnSignIn)} disabled={busy} onChange={(e) => save({ notifyOnSignIn: e.target.checked })} />
            {demo.notifyOnSignIn ? <Bell size={13} /> : <BellOff size={13} />}
            Alert when opened
          </label>
        </div>
      )}
    </div>
  );
}

function VisitsModal({ demo, canManage, onClose, onChanged }) {
  const [visits, setVisits] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/api/crm/demo-academies/${demo.id}/visits`);
      setVisits(r.visits || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [demo.id]);
  useEffect(() => { load(); }, [load]);

  const reset = async () => {
    if (!window.confirm(`Forget every visit to the ${demo.name} demo so far? Do this after a colleague has been in, so the next visit on record is the client's. It cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/crm/demo-academies/${demo.id}/reset-visits`, {});
      onChanged(r.demo);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={680}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Logo demo={demo} size={28} />
        <h2 style={{ margin: 0, fontSize: 17, color: BRAND.ink }}>{demo.name}</h2>
      </div>

      <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '10px 12px', marginBottom: 14, fontSize: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <strong style={{ flex: 1 }}>Logins</strong>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => copy('all', loginsText(demo))}>
            <Copy size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{copied === 'all' ? 'Copied' : 'Copy all'}
          </button>
        </div>
        {(demo.logins || []).map((l) => (
          <div key={l.email} style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
            <span style={{ width: 80, color: BRAND.muted }}>{roleLabel(l.role)}</span>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>{l.email}</span>
          </div>
        ))}
        {demo.password && (
          <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
            <span style={{ width: 80, color: BRAND.muted }}>Password</span>
            <span style={{ flex: 1 }}>{demo.password}</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ flex: 1, fontSize: 14, color: BRAND.ink }}>Visits</strong>
        {canManage && (
          <button className="btn-ghost" onClick={reset} disabled={busy} style={{ fontSize: 12 }}>Reset tracking</button>
        )}
      </div>
      {error && <p role="alert" style={{ color: '#B91C1C', fontSize: 13 }}>{error}</p>}
      {!visits && !error && <p style={{ color: BRAND.muted, fontSize: 13 }}>Loading…</p>}
      {visits && visits.length === 0 && (
        <p style={{ color: BRAND.muted, fontSize: 13 }}>Nobody has been in with the demo logins yet.</p>
      )}
      {visits && visits.map((v) => (
        <div key={v.start} style={{ borderTop: '1px solid ' + BRAND.border, padding: '10px 0' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink }}>
            {fmtWhen(v.start)}
            <span style={{ fontWeight: 500, color: BRAND.muted }}> · {v.minutes} min · {v.device}</span>
          </div>
          {v.logins?.length > 0 && <div style={{ fontSize: 12, color: BRAND.muted }}>{v.logins.join(', ')}</div>}
          <ul style={{ margin: '6px 0 0', paddingLeft: 0, listStyle: 'none' }}>
            {v.events.map((e, i) => (
              <li key={i} style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '2px 0' }}>
                <span style={{ width: 42, color: BRAND.muted, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtTime(e.at)}</span>
                <span style={{ color: BRAND.ink }}>{e.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Modal>
  );
}

function LinkDealModal({ demo, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async (dealId) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/crm/demo-academies/${demo.id}/link`, { dealId });
      onDone(r.demo);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} maxWidth={520} overflow="visible">
      <h2 style={{ margin: '0 0 4px', fontSize: 17, color: BRAND.ink }}>Which deal is the {demo.name} demo for?</h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: BRAND.muted }}>
        Visits then show on the deal's timeline, and the alert names it.
      </p>
      <DealSearchPicker onPick={(deal) => save(deal.id)} busy={busy} placeholder="Search deals or companies…" />
      {error && <p role="alert" style={{ color: '#B91C1C', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        {demo.deal && (
          <button className="btn-ghost" type="button" onClick={() => save(null)} disabled={busy} style={{ marginRight: 'auto' }}>Unlink</button>
        )}
        <button className="btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </Modal>
  );
}

export function DemoAcademiesView() {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  const [visitsFor, setVisitsFor] = useState(null);
  const [linking, setLinking] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api.get('/api/crm/demo-academies'));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const demos = data?.demos || [];
  const groups = useMemo(() => groupDemos(filter === 'all' ? demos : demos.filter((d) => d.demoType === filter)), [demos, filter]);
  // One demo changed: swap it in place rather than reloading every visit.
  const changed = (demo) => {
    if (demo) setData((d) => (d ? { ...d, demos: d.demos.map((x) => (x.id === demo.id ? demo : x)) } : d));
    setLinking(null);
  };

  return (
    <div style={{ padding: isMobile ? '16px 12px 80px' : '20px 24px 60px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: BRAND.ink }}>
          <MonitorPlay size={19} style={{ verticalAlign: -3, marginRight: 8, color: BRAND.blue }} />
          Demos
        </h1>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={load} disabled={busy} style={{ fontSize: 12 }}>
          <RefreshCw size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Refresh
        </button>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted }}>
        The demo academies built for prospects, and who has been into each. You get an alert (the eye bell) when a
        prospect signs in; link a demo to its deal and the visit shows there too.
      </p>

      {error && (
        <div role="alert" style={{ border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const count = f.key === 'all' ? demos.length : demos.filter((d) => d.demoType === f.key).length;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} className={filter === f.key ? 'btn' : 'btn-ghost'} style={{ fontSize: 12.5 }}>
              {f.label}{data ? ` · ${count}` : ''}
            </button>
          );
        })}
      </div>

      {!data && !error && <div style={{ padding: 24, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>Loading…</div>}
      {data && groups.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>No demos here yet.</div>}

      {groups.map((g) => (
        <section key={g.type || 'none'} style={{ marginBottom: 22 }}>
          <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: BRAND.muted, margin: '0 0 8px' }}>
            {g.label}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {g.demos.map((d) => (
              <DemoCard
                key={d.id}
                demo={d}
                canManage={data?.canManage}
                onOpen={setVisitsFor}
                onLink={setLinking}
                onChanged={changed}
                setError={setError}
              />
            ))}
          </div>
        </section>
      ))}

      {visitsFor && (
        <VisitsModal
          demo={demos.find((d) => d.id === visitsFor.id) || visitsFor}
          canManage={data?.canManage}
          onClose={() => setVisitsFor(null)}
          onChanged={changed}
        />
      )}
      {linking && <LinkDealModal demo={linking} onClose={() => setLinking(null)} onDone={changed} />}
    </div>
  );
}
