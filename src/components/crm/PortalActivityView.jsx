// "Client portal activity" — every client's presence in the portal, newest
// first: sign-ins, the pages they open, the files they download.
//
// This is the watching surface, not the notifying one. Nothing here raises an
// alert: the team is told about the handful of events that need a response
// (an invite accepted, video credit ordered, an extra bought, a PO submitted),
// and everything else is here to be looked at when someone wants to know how a
// client is getting on.
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Building2, Download, Eye, LogIn, RefreshCw, Users } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { formatRelativeTime, useIsMobile } from '../../utils.js';
import { Card, Empty } from './Card.jsx';

const ICONS = { login: LogIn, download: Download, view: Eye };
const TONES = { login: '#16A34A', download: '#7C3AED', view: '#64748B' };

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

// The company a row belongs to. Clickable only where there's somewhere to go:
// the producer/copywriter shell has no company pages, so there it's plain text
// rather than a button that does nothing.
const CHIP = { padding: 0, fontSize: 11.5, color: BRAND.muted, display: 'inline-flex', alignItems: 'center', gap: 4 };
function CompanyChip({ id, name, onOpen }) {
  const inner = <><Building2 size={11} /> {name}</>;
  if (!id || !onOpen) return <span style={CHIP}>{inner}</span>;
  return <button className="btn-ghost" onClick={() => onOpen(id)} style={CHIP}>{inner}</button>;
}

export function PortalActivityView({ onOpenCompany, onOpenDeal, onOpenContact }) {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState('timeline'); // 'timeline' | 'people'
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [done, setDone] = useState(false);
  const [days, setDays] = useState('30');
  const [people, setPeople] = useState(null);
  const [peopleBusy, setPeopleBusy] = useState(false);

  const loadPeople = useCallback(async () => {
    setPeopleBusy(true);
    try {
      const q = new URLSearchParams({ op: 'active-users', days });
      if (companyId) q.set('companyId', companyId);
      const r = await api.get(`/api/crm/portal-admin?${q.toString()}`);
      setPeople(r.users || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setPeopleBusy(false);
    }
  }, [companyId, days]);

  useEffect(() => { if (mode === 'people') loadPeople(); }, [mode, loadPeople]);

  const load = useCallback(async ({ append = false } = {}) => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ op: 'activity', limit: '100' });
      if (companyId) q.set('companyId', companyId);
      // Cursor on the oldest row we hold, so paging can't skip or repeat.
      if (append && items?.length) q.set('before', items[items.length - 1].at);
      const r = await api.get(`/api/crm/portal-admin?${q.toString()}`);
      const next = r.items || [];
      setItems(append ? [...(items || []), ...next] : next);
      setDone(next.length < 100);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [companyId, items]);

  useEffect(() => { load(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every organisation that appears in the feed — enough to filter by without
  // loading the whole company list.
  const companies = [...new Map((items || [])
    .filter((i) => i.companyId)
    .map((i) => [i.companyId, i.companyName])).entries()];

  return (
    <div style={{ padding: isMobile ? '16px 12px 80px' : '20px 24px 60px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: BRAND.ink }}>
          <Activity size={18} style={{ verticalAlign: -3, marginRight: 8, color: BRAND.blue }} />
          Client portal activity
        </h1>
        <div style={{ flex: 1 }} />
        {mode === 'people' && (
          <select className="input" value={days} onChange={(e) => setDays(e.target.value)} style={{ fontSize: 13, maxWidth: 150 }}>
            {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        )}
        {companies.length > 1 && (
          <select className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={{ fontSize: 13, maxWidth: 260 }}>
            <option value="">All clients</option>
            {companies.map(([id, nm]) => <option key={id} value={id}>{nm}</option>)}
          </select>
        )}
        <button
          className="btn-ghost"
          onClick={() => (mode === 'people' ? loadPeople() : load())}
          disabled={busy || peopleBusy}
          style={{ fontSize: 12 }}
        >
          <RefreshCw size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Refresh
        </button>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: BRAND.muted }}>
        Sign-ins, the pages clients open and the files they download. Staff previews aren't recorded.
      </p>

      {/* Same events, two questions: "what happened" and "who's engaged". */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {[['timeline', 'Timeline', Activity], ['people', 'Most active', Users]].map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={mode === key ? 'btn' : 'btn-ghost'}
            style={{ fontSize: 12.5 }}
          >
            <Icon size={13} style={{ verticalAlign: -2, marginRight: 5 }} />{label}
          </button>
        ))}
      </div>

      {mode === 'people' && (
        <Card>
          {error && <Empty text={error} />}
          {!error && !people && <Empty text="Loading…" />}
          {people && people.length === 0 && (
            <Empty text="Nobody has been in the portal in this window." />
          )}
          {(people || []).map((p, i) => (
            <div key={p.portalUserId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px', borderBottom: '1px solid ' + BRAND.border, fontSize: 13 }}>
              <span style={{ width: 20, textAlign: 'right', color: BRAND.muted, fontSize: 12, flexShrink: 0 }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: BRAND.ink, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {p.contactId && onOpenContact ? (
                    <button className="btn-ghost" onClick={() => onOpenContact(p.contactId)} style={{ padding: 0, fontSize: 13, fontWeight: 600, color: BRAND.ink }}>
                      {p.name || p.email}
                    </button>
                  ) : (p.name || p.email)}
                  {p.disabled && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#B91C1C', background: '#DC262618', padding: '1px 6px', borderRadius: 4 }}>DISABLED</span>}
                </div>
                <div style={{ fontSize: 11.5, color: BRAND.muted, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {p.companies && (
                    <CompanyChip id={p.companyId} name={p.companies} onOpen={onOpenCompany} />
                  )}
                  <span>{p.logins} sign-in{p.logins === 1 ? '' : 's'}</span>
                  <span>{p.activeDays} active day{p.activeDays === 1 ? '' : 's'}</span>
                  {p.courseStarted > 0 && <span>{p.courseDone} course video{p.courseDone === 1 ? '' : 's'} watched</span>}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontWeight: 700, color: BRAND.ink, fontSize: 14 }}>{p.events}</div>
                <div style={{ fontSize: 11, color: BRAND.muted }}>{formatRelativeTime(p.lastAt)}</div>
              </div>
            </div>
          ))}
        </Card>
      )}

      {mode === 'timeline' && (
      <Card>
        {error && <Empty text={error} />}
        {!error && !items && <Empty text="Loading…" />}
        {items && items.length === 0 && (
          <Empty text="Nothing yet — this fills up as clients use their portal." />
        )}
        {(items || []).map((it) => {
          const Icon = ICONS[it.type] || Eye;
          const tone = TONES[it.type] || BRAND.muted;
          return (
            <div key={it.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 2px', borderBottom: '1px solid ' + BRAND.border, fontSize: 13 }}>
              <Icon size={14} color={tone} style={{ flexShrink: 0, marginTop: 3 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: BRAND.ink }}>
                  <strong>{it.actor || 'Someone'}</strong>{' '}
                  {it.dealId && onOpenDeal ? (
                    <button className="btn-ghost" onClick={() => onOpenDeal(it.dealId)} style={{ padding: 0, fontSize: 13, color: BRAND.ink }}>
                      {it.text}
                    </button>
                  ) : it.text}
                </div>
                <div style={{ fontSize: 11.5, color: BRAND.muted, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {it.companyName && (
                    <CompanyChip id={it.companyId} name={it.companyName} onOpen={onOpenCompany} />
                  )}
                  {it.loc && <span>{it.loc}</span>}
                </div>
              </div>
              <span style={{ fontSize: 11.5, color: BRAND.muted, flexShrink: 0 }}>{formatRelativeTime(it.at)}</span>
            </div>
          );
        })}
        {items && items.length > 0 && !done && (
          <div style={{ textAlign: 'center', paddingTop: 12 }}>
            <button className="btn-ghost" onClick={() => load({ append: true })} disabled={busy} style={{ fontSize: 12.5 }}>
              {busy ? 'Loading…' : 'Load older'}
            </button>
          </div>
        )}
      </Card>
      )}
    </div>
  );
}
