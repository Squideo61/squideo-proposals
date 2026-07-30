// Staff activity — a management view with the audit trail attached.
//
// Top half answers "how is everyone doing": actions in the period, days active,
// where the effort went, when they were last on. Bottom half is the trail
// itself: every change, newest first, with before → after on the records we
// diff (deals, organisations, contacts, tasks, extras).
//
// Sign-ins and writes are recorded; opening a page isn't — reads would bury the
// feed a hundred to one and aren't the question this answers.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity, ChevronDown, ChevronRight, LogIn, Mail, Pencil, Plus, RefreshCw, Trash2, Undo2,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { formatRelativeTime, useIsMobile } from '../../utils.js';

const PERIODS = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const ENTITY_LABELS = {
  deals: 'Deals', companies: 'Organisations', contacts: 'Contacts', tasks: 'Tasks',
  proposals: 'Proposals', extras: 'Extras', comments: 'Comments', payments: 'Payments',
  invoices: 'Invoices', production: 'Production', schedule: 'Schedule', email: 'Emails',
  threads: 'Email threads', templates: 'Templates', voiceovers: 'Voiceovers',
  portal: 'Client portal', users: 'People', roles: 'Roles', auth: 'Sign-ins',
  restore: 'Restores',
};

// Records a row can open. The rest still show their label, just not as a link.
const OPENABLE = new Set(['deals', 'companies', 'contacts']);

function iconFor(action) {
  if (action.startsWith('auth.')) return { Icon: LogIn, tone: '#16A34A' };
  if (action.startsWith('gmail.')) return { Icon: Mail, tone: '#2563EB' };
  if (action.startsWith('restore.')) return { Icon: Undo2, tone: '#7C3AED' };
  if (action.endsWith('.create')) return { Icon: Plus, tone: '#16A34A' };
  if (action.endsWith('.delete')) return { Icon: Trash2, tone: '#DC2626' };
  return { Icon: Pencil, tone: '#64748B' };
}

const fieldName = (f) => String(f || '').replace(/_/g, ' ').replace(/\bat\b$/, '').trim();
const shownValue = (v) => (v === null || v === '' ? '—' : String(v));

export function StaffActivityTab({ onOpenRecord }) {
  const isMobile = useIsMobile();
  const [days, setDays] = useState(7);
  const [actor, setActor] = useState('');
  const [entity, setEntity] = useState('');
  const [data, setData] = useState(null);   // { items, people }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async ({ append = false, items = [] } = {}) => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ days: String(days) });
      if (actor) q.set('actor', actor);
      if (entity) q.set('entity', entity);
      // Cursor on the oldest row we hold, so paging can't skip or repeat.
      if (append && items.length) q.set('before', items[items.length - 1].at);
      const r = await api.get(`/api/crm/activity?${q.toString()}`);
      const next = r.items || [];
      setDone(next.length < 100);
      setData((cur) => ({
        people: append ? cur?.people || [] : r.people || [],
        items: append ? [...items, ...next] : next,
      }));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [days, actor, entity]);

  useEffect(() => { load(); }, [load]);

  const people = data?.people || [];
  const items = data?.items || [];
  const busiest = people[0]?.actions || 1;

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>Staff activity</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.55 }}>
        Every change made in the CRM and who made it, plus sign-ins. Opening a page isn't recorded —
        only doing something. Changes to deals, organisations, contacts, tasks and extras are kept
        field by field, so you can see exactly what a value went from and to. Held for 12 months.
      </p>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
          {PERIODS.map((p) => (
            <button
              key={p.days}
              onClick={() => setDays(p.days)}
              className="btn-ghost"
              style={{
                fontSize: 12.5, padding: '5px 11px', borderRadius: 6,
                background: days === p.days ? 'white' : 'transparent',
                fontWeight: days === p.days ? 700 : 500,
                color: days === p.days ? BRAND.ink : BRAND.muted,
                boxShadow: days === p.days ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <select className="input" value={actor} onChange={(e) => setActor(e.target.value)} style={{ fontSize: 13, maxWidth: 200 }}>
          <option value="">Everyone</option>
          {people.map((p) => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
        </select>
        <select className="input" value={entity} onChange={(e) => setEntity(e.target.value)} style={{ fontSize: 13, maxWidth: 180 }}>
          <option value="">Everything</option>
          {Object.entries(ENTITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn-ghost" onClick={() => load()} disabled={busy} style={{ fontSize: 12 }}>
          <RefreshCw size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Refresh
        </button>
      </div>

      {error && (
        <div style={{ padding: 14, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, color: '#B91C1C', fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Who's been busy */}
      {people.length > 0 && (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Who's been busy
          </h3>
          {people.map((p) => (
            <div key={p.email || 'unknown'} style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '10px 2px', borderBottom: '1px solid ' + BRAND.border,
            }}>
              <button
                className="btn-ghost"
                onClick={() => setActor(actor === p.email ? '' : p.email)}
                style={{ padding: 0, fontSize: 13.5, fontWeight: 700, color: BRAND.ink, minWidth: 140, textAlign: 'left' }}
              >
                {p.name || p.email || 'Unknown'}
              </button>
              <div style={{ flex: 1, minWidth: 120 }}>
                {/* Relative to the busiest person in the period — this is a
                    comparison, not a target. */}
                <div style={{ height: 6, background: '#F1F5F9', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.max(3, (p.actions / busiest) * 100)}%`, background: BRAND.blue, borderRadius: 999 }} />
                </div>
                {!isMobile && p.areas.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    {p.areas.map((a) => (
                      <span key={a.entity} style={{ fontSize: 10.5, color: BRAND.muted, background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 999, padding: '2px 7px' }}>
                        {ENTITY_LABELS[a.entity] || a.entity} {a.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: BRAND.muted, textAlign: 'right', minWidth: 150 }}>
                <strong style={{ color: BRAND.ink, fontSize: 13 }}>{p.actions}</strong> actions ·{' '}
                {p.activeDays} day{p.activeDays === 1 ? '' : 's'} active
                <div>last {formatRelativeTime(p.lastAt)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The trail */}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Activity
        </h3>
        {!data && !error && <div style={{ padding: 12, fontSize: 13, color: BRAND.muted }}>Loading…</div>}
        {data && items.length === 0 && (
          <div style={{ padding: '12px 2px', fontSize: 13, color: BRAND.muted, fontStyle: 'italic' }}>
            Nothing recorded in this period. Logging started when this went live — it won't show work done before then.
          </div>
        )}
        {items.map((it) => {
          const { Icon, tone } = iconFor(it.action);
          const open = openId === it.id;
          const changes = it.changes || [];
          const shown = open ? changes : changes.slice(0, 2);
          return (
            <div key={it.id} style={{ display: 'flex', gap: 10, padding: '9px 2px', borderBottom: '1px solid ' + BRAND.border, fontSize: 13, alignItems: 'flex-start' }}>
              <Icon size={14} color={tone} style={{ flexShrink: 0, marginTop: 3 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: BRAND.ink }}>
                  <strong>{it.actorName || it.actorEmail || 'Someone'}</strong> {it.summary}
                  {it.entityLabel && (
                    <>
                      {' · '}
                      {OPENABLE.has(it.entity) && it.entityId && onOpenRecord ? (
                        <button className="btn-ghost" onClick={() => onOpenRecord(it.entity, it.entityId)}
                          style={{ padding: 0, fontSize: 13, color: BRAND.blue, fontWeight: 600 }}>
                          {it.entityLabel}
                        </button>
                      ) : (
                        <span style={{ color: BRAND.muted }}>{it.entityLabel}</span>
                      )}
                    </>
                  )}
                </div>
                {shown.length > 0 && (
                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {shown.map((c) => (
                      <div key={c.field} style={{ fontSize: 11.5, color: BRAND.muted, wordBreak: 'break-word' }}>
                        <span style={{ fontWeight: 600 }}>{fieldName(c.field)}</span>{' '}
                        <span style={{ textDecoration: 'line-through', opacity: 0.75 }}>{shownValue(c.from)}</span>
                        {' → '}
                        <span style={{ color: BRAND.ink }}>{shownValue(c.to)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {changes.length > 2 && (
                  <button className="btn-ghost" onClick={() => setOpenId(open ? null : it.id)}
                    style={{ padding: '2px 0', fontSize: 11.5, color: BRAND.blue }}>
                    {open
                      ? <><ChevronDown size={11} style={{ verticalAlign: -1 }} /> Fewer</>
                      : <><ChevronRight size={11} style={{ verticalAlign: -1 }} /> {changes.length - 2} more change{changes.length - 2 === 1 ? '' : 's'}</>}
                  </button>
                )}
                {open && it.meta?.ip && (
                  <div style={{ fontSize: 10.5, color: BRAND.muted, marginTop: 3 }}>
                    {[it.meta.method, it.meta.path, it.meta.via, it.meta.ip].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11.5, color: BRAND.muted, flexShrink: 0 }}>{formatRelativeTime(it.at)}</span>
            </div>
          );
        })}
        {items.length > 0 && !done && (
          <div style={{ textAlign: 'center', paddingTop: 12 }}>
            <button className="btn-ghost" onClick={() => load({ append: true, items })} disabled={busy} style={{ fontSize: 12.5 }}>
              {busy ? 'Loading…' : 'Load older'}
            </button>
          </div>
        )}
      </div>

      <p style={{ margin: '14px 2px 0', fontSize: 11.5, color: BRAND.muted, lineHeight: 1.5 }}>
        <Activity size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
        Staff should know this log exists — it records people, not just records, and each line keeps
        the IP the change came from.
      </p>
    </div>
  );
}
