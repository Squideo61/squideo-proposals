// Marketing → Brief builder. What the lead magnet is doing: who started a
// brief, how far they got, what they wrote, and whether the nudge sequence
// chasing them is being read.
//
// The order is deliberate. The funnel answers "is this working at all", the
// sequence table answers "are the reminders worth sending", and the list is the
// working surface — a half-finished brief is a warm lead with its own
// requirements document attached, which is a better call than most enquiries.
// Question-level answer rates sit last, collapsed: they're for editing the
// form, not for running the week.

import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, ChevronDown, ChevronRight, Mail, MailOpen, ExternalLink, Clock, Ban,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useIsMobile } from '../../utils.js';
import { ResponsiveTable, Modal } from '../ui.jsx';

const STATUS = {
  submitted:   { label: 'Sent to us',  bg: '#ECFDF5', border: '#A7F3D0', ink: '#047857' },
  complete:    { label: 'Finished',    bg: '#EFF6FF', border: '#BFDBFE', ink: '#1D4ED8' },
  in_progress: { label: 'In progress', bg: '#FFF8EB', border: '#F5C26B', ink: '#B45309' },
  empty:       { label: 'Not started', bg: '#F1F5F9', border: BRAND.border, ink: BRAND.muted },
};

const NEXT_STEP = { call: 'Wants a call', quote: 'Wants a price' };

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');
const ago = (d) => {
  if (!d) return '—';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return fmtDate(d);
};
const pctText = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);

// A brief's "title" is whatever the client typed as the project name, and
// people paste an entire script into that box. Left alone it turns one table
// row into a full page of text — burying every other row, and defeating the
// point of a row, which is to summarise. The full text is never lost: it's the
// project-name answer, listed under "What they've written" when you open it.
const TITLE_MAX = 110;
const shortTitle = (t, max = TITLE_MAX) => {
  const s = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
  if (!s) return 'Untitled brief';
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
};

// Belt and braces with shortTitle: the string is cut so the layout can't blow
// up, and the box is clamped so a cut string still can't wrap past two lines.
const CLAMP_2 = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  overflowWrap: 'anywhere',
};

export function BriefBuilderTab({ from, to, onOpenCompany }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    setError(null);
    setData(null);
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api.get('/api/crm/analytics/briefs?' + q.toString())
      .then(setData)
      .catch((e) => setError(e.message));
  }, [from, to, reload]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    if (filter === 'all') return all;
    if (filter === 'live') return all.filter((r) => r.status === 'in_progress' || r.status === 'complete');
    return all.filter((r) => r.status === filter);
  }, [data, filter]);

  if (error) {
    return (
      <div style={{ padding: 30, textAlign: 'center', color: BRAND.muted, fontSize: 13.5 }}>
        Couldn't load brief data — {error}
        <div style={{ marginTop: 12 }}>
          <button className="btn-ghost" onClick={() => setReload((n) => n + 1)}><RefreshCw size={13} /> Try again</button>
        </div>
      </div>
    );
  }
  if (!data) return <div style={{ padding: 30, color: BRAND.muted, fontSize: 13.5 }}>Loading…</div>;

  const f = data.funnel;

  return (
    <div>
      <div style={{
        display: 'grid', gap: 10, marginBottom: 22,
        gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fit, minmax(140px, 1fr))',
      }}>
        <Stat label="Signed up" value={f.signups} sub="through the builder" />
        <Stat label="Briefs started" value={f.started} accent={BRAND.blue} />
        <Stat label="Answered something" value={f.touched} sub={rate(f.touched, f.started)} />
        <Stat label="Avg completion" value={`${Math.round(f.avgPct)}%`} />
        <Stat label="Finished" value={f.finished} sub={rate(f.finished, f.started)} />
        <Stat label="Sent to us" value={f.submitted} sub={rate(f.submitted, f.started)} accent="#16A34A" />
        <Stat label="Became a deal" value={f.withDeal} sub={rate(f.withDeal, f.started)} />
      </div>

      <Section title="How far they get">
        <Bands bands={data.bands} total={f.started} />
        {(data.nextSteps.call > 0 || data.nextSteps.quote > 0) && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: BRAND.muted }}>
            After finishing, <strong style={{ color: BRAND.ink }}>{data.nextSteps.call}</strong> asked for a call
            and <strong style={{ color: BRAND.ink }}>{data.nextSteps.quote}</strong> asked for a price.
          </div>
        )}
      </Section>

      <Section title="Reminder emails">
        <NudgeTable nudges={data.nudges} />
      </Section>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '26px 0 12px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: BRAND.ink }}>
          Briefs ({data.rows.length})
        </h3>
        <div style={{ flex: 1 }} />
        {[
          ['all', 'All'],
          ['live', 'Open'],
          ['submitted', 'Sent to us'],
          ['empty', 'Not started'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              fontSize: 12, fontWeight: filter === key ? 700 : 600, padding: '4px 11px',
              borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
              background: filter === key ? BRAND.ink : '#fff',
              color: filter === key ? '#fff' : BRAND.muted,
              border: '1px solid ' + (filter === key ? BRAND.ink : BRAND.border),
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <ResponsiveTable
        columns={[
          {
            key: 'who',
            label: 'Who',
            render: (r) => (
              <div>
                <div style={{ fontWeight: 600, color: BRAND.ink }}>{r.name || r.email || 'Unknown'}</div>
                <div style={{ fontSize: 11.5, color: BRAND.muted }}>{r.companyName || r.email}</div>
              </div>
            ),
          },
          {
            key: 'title',
            label: 'Brief',
            render: (r) => (
              <div style={{ maxWidth: 360 }}>
                <div style={{ color: BRAND.ink, ...CLAMP_2 }} title={r.title || ''}>
                  {shortTitle(r.title)}
                </div>
                {r.contributors > 1 && (
                  <div style={{ fontSize: 11.5, color: BRAND.muted }}>{r.contributors} people</div>
                )}
              </div>
            ),
          },
          { key: 'progress', label: 'Progress', render: (r) => <Progress pct={r.pct} done={r.done} total={r.total} /> },
          { key: 'status', label: 'Status', render: (r) => <Pill status={r.status} nextStep={r.nextStep} /> },
          {
            key: 'nudges',
            label: 'Reminders',
            render: (r) => (
              r.nudgesSent === 0
                ? <span style={{ color: BRAND.muted }}>{r.nudgesQueued > 0 ? `${r.nudgesQueued} queued` : '—'}</span>
                : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: BRAND.ink }}>
                    {r.nudgesOpened > 0 ? <MailOpen size={13} color="#16A34A" /> : <Mail size={13} color={BRAND.muted} />}
                    {r.nudgesOpened}/{r.nudgesSent} opened
                  </span>
                )
            ),
          },
          { key: 'updatedAt', label: 'Last touched', render: (r) => <span style={{ color: BRAND.muted }}>{ago(r.updatedAt)}</span> },
        ]}
        rows={rows}
        onRowClick={(r) => setOpenId(r.id)}
        empty={data.rows.length === 0
          ? 'No briefs started in this period yet.'
          : 'Nothing in that filter.'}
      />

      <Questions questions={data.questions} started={f.started} />

      {openId && <BriefDetail id={openId} onClose={() => setOpenId(null)} onOpenCompany={onOpenCompany} />}
    </div>
  );
}

// ── the drill-in ─────────────────────────────────────────────────────────────

function BriefDetail({ id, onClose, onOpenCompany }) {
  const [b, setB] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/crm/analytics/brief/' + encodeURIComponent(id))
      .then(setB)
      .catch((e) => setError(e.message));
  }, [id]);

  return (
    <Modal onClose={onClose} maxWidth={760}>
      {error ? (
        <div style={{ padding: 24, color: BRAND.muted }}>Couldn't load this brief — {error}</div>
      ) : !b ? (
        <div style={{ padding: 24, color: BRAND.muted }}>Loading…</div>
      ) : (
        <div style={{ padding: 4 }}>
          {/* Clamped here too. A heading made of someone's entire pasted script
              pushes everything worth reading — progress, the deal link, the
              answers themselves — below the fold of the modal. */}
          <h2 style={{ margin: '0 0 4px', fontSize: 19, fontWeight: 700, color: BRAND.ink, paddingRight: 30, ...CLAMP_2 }}
              title={b.title || ''}>
            {shortTitle(b.title, 160)}
          </h2>
          <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 14 }}>
            {b.name || b.email}
            {b.companyName && <> · {onOpenCompany && b.companyId
              ? <button onClick={() => { onClose(); onOpenCompany(b.companyId); }}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: BRAND.blue, fontSize: 13, fontFamily: 'inherit' }}>
                  {b.companyName}
                </button>
              : b.companyName}</>}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 18 }}>
            <Pill status={b.submittedAt ? 'submitted' : b.pct >= 100 ? 'complete' : b.pct > 0 ? 'in_progress' : 'empty'} nextStep={b.nextStep} />
            <Progress pct={b.pct} done={b.done} total={b.total} />
            <div style={{ fontSize: 12.5, color: BRAND.muted }}>
              Started {fmtDate(b.createdAt)} · last touched {ago(b.updatedAt)}
              {b.contributors > 1 && ` · ${b.contributors} people`}
            </div>
          </div>

          {b.dealId && (
            <div style={{ marginBottom: 18, fontSize: 13 }}>
              <a href={`#/deal/${b.dealId}`} style={{ color: BRAND.blue, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <ExternalLink size={13} /> {b.dealTitle || 'Open the deal'}
              </a>
            </div>
          )}

          <h3 style={SUBHEAD}>Reminder emails</h3>
          {b.nudges.length === 0 ? (
            <p style={{ margin: '0 0 18px', fontSize: 13, color: BRAND.muted }}>
              None queued — the sequence only runs for people who signed up through the builder itself.
            </p>
          ) : (
            <div style={{ marginBottom: 20, border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
              {b.nudges.map((n) => (
                <div key={n.kind} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                  borderTop: '1px solid ' + BRAND.border, fontSize: 13,
                }}>
                  <NudgeIcon n={n} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: BRAND.ink, fontWeight: 600 }}>{n.label}</div>
                    <div style={{ fontSize: 11.5, color: BRAND.muted }}>{nudgeState(n)}</div>
                  </div>
                  {n.sentAt && n.tracked && (
                    <div style={{ fontSize: 11.5, color: n.openedAt ? '#047857' : BRAND.muted, textAlign: 'right' }}>
                      {n.openedAt ? `Opened ${ago(n.openedAt)}` : 'Not opened'}
                      {n.clicks > 0 && <div>{n.clicks} click{n.clicks === 1 ? '' : 's'}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <h3 style={SUBHEAD}>What they've written</h3>
          {b.screens.map((s) => {
            const answered = s.questions.filter((q) => q.value != null);
            return (
              <div key={s.key} style={{ marginBottom: 16 }}>
                <div style={{
                  fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                  color: BRAND.muted, marginBottom: 8,
                }}>
                  {s.title} · {answered.length}/{s.questions.length}
                </div>
                {s.questions.map((q) => (
                  <div key={q.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: BRAND.muted }}>{q.label}</div>
                    <div style={{
                      fontSize: 13.5, color: q.value == null ? '#B4C2CC' : BRAND.ink,
                      fontStyle: q.value == null ? 'italic' : 'normal',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      {q.value == null ? 'Not answered' : q.value}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function NudgeIcon({ n }) {
  if (n.cancelledAt) return <Ban size={15} color={BRAND.muted} />;
  if (!n.sentAt) return <Clock size={15} color={BRAND.muted} />;
  return n.openedAt ? <MailOpen size={15} color="#16A34A" /> : <Mail size={15} color={BRAND.muted} />;
}

function nudgeState(n) {
  if (n.cancelledAt) return `Cancelled ${fmtDate(n.cancelledAt)} — they'd already got in touch or finished`;
  if (!n.sentAt) return `Due ${fmtDate(n.scheduledFor)}`;
  if (!n.tracked) return `Sent ${fmtDate(n.sentAt)} — sent before open tracking, so unmeasured`;
  return `Sent ${fmtDate(n.sentAt)}`;
}

// ── pieces ───────────────────────────────────────────────────────────────────

const SUBHEAD = { margin: '0 0 10px', fontSize: 14, fontWeight: 700, color: BRAND.ink };

const rate = (n, of) => (of > 0 ? `${Math.round((n / of) * 100)}% of started` : null);

function Stat({ label, value, sub, accent }) {
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
      <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || BRAND.ink, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: BRAND.ink }}>{title}</h3>
      {children}
    </div>
  );
}

function Bands({ bands, total }) {
  const max = Math.max(1, ...bands.map((b) => b.count));
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
      {bands.map((b) => (
        <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 13 }}>
          <div style={{ width: 84, color: BRAND.muted, flexShrink: 0 }}>{b.label}</div>
          <div style={{ flex: 1, background: BRAND.paper, borderRadius: 4, height: 16, overflow: 'hidden', minWidth: 0 }}>
            <div style={{
              width: `${(b.count / max) * 100}%`, height: '100%',
              background: b.key === 'full' ? '#16A34A' : b.key === 'empty' ? '#CBD5E1' : BRAND.blue,
            }} />
          </div>
          <div style={{ width: 62, textAlign: 'right', color: BRAND.ink, flexShrink: 0 }}>
            {b.count}
            {total > 0 && <span style={{ color: BRAND.muted, fontSize: 11.5 }}> · {Math.round((b.count / total) * 100)}%</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function NudgeTable({ nudges }) {
  const untracked = nudges.sent - nudges.tracked;
  return (
    <div>
      <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
              <th style={TH}>Step</th>
              <th style={{ ...TH, textAlign: 'right' }}>Sent</th>
              <th style={{ ...TH, textAlign: 'right' }}>Opened</th>
              <th style={{ ...TH, textAlign: 'right' }}>Open rate</th>
              <th style={{ ...TH, textAlign: 'right' }}>Clicked</th>
            </tr>
          </thead>
          <tbody>
            {nudges.byKind.map((k) => (
              <tr key={k.kind} style={{ borderTop: '1px solid ' + BRAND.border }}>
                <td style={TD}>{k.label}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{k.sent}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{k.opened}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{pctText(k.openRate)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{k.clicked}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid ' + BRAND.border, fontWeight: 700, background: BRAND.paper }}>
              <td style={TD}>Total</td>
              <td style={{ ...TD, textAlign: 'right' }}>{nudges.sent}</td>
              <td style={{ ...TD, textAlign: 'right' }}>{nudges.opened}</td>
              <td style={{ ...TD, textAlign: 'right' }}>{pctText(nudges.openRate)}</td>
              <td style={{ ...TD, textAlign: 'right' }}>{nudges.clicked}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 8, lineHeight: 1.5 }}>
        {nudges.queuedNow} queued to go out · {nudges.cancelledTotal} cancelled because they got in touch or finished.
        {untracked > 0 && ` Open rates are out of the ${nudges.tracked} tracked sends — ${untracked} went out before open tracking existed.`}
        {' '}Opens are approximate: a mail client that blocks images never reports one.
      </div>
    </div>
  );
}

function Questions({ questions, started }) {
  const [open, setOpen] = useState(false);
  const byScreen = useMemo(() => {
    const map = new Map();
    for (const q of questions) {
      if (!map.has(q.screen)) map.set(q.screen, { title: q.screenTitle, items: [] });
      map.get(q.screen).items.push(q);
    }
    return [...map.values()];
  }, [questions]);

  return (
    <div style={{ marginTop: 26 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, fontWeight: 700, color: BRAND.ink,
        }}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Which questions get answered
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: BRAND.muted }}>
            Out of {started} brief{started === 1 ? '' : 's'} started in this period. A question far below the ones
            around it is either badly worded or asking for something people don't have to hand yet.
          </p>
          {byScreen.map((s) => (
            <div key={s.title} style={{ marginBottom: 14 }}>
              <div style={{
                fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                color: BRAND.muted, marginBottom: 6,
              }}>
                {s.title}
              </div>
              {s.items.map((q) => (
                <div key={q.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0', fontSize: 12.5 }}>
                  <div style={{ flex: '1 1 auto', minWidth: 0, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={q.label}>
                    {q.label}{q.required && <span style={{ color: '#DC2626' }}> *</span>}
                  </div>
                  <div style={{ width: 110, background: BRAND.paper, borderRadius: 4, height: 10, overflow: 'hidden', flexShrink: 0 }}>
                    <div style={{ width: `${q.pct}%`, height: '100%', background: BRAND.blue }} />
                  </div>
                  <div style={{ width: 42, textAlign: 'right', color: BRAND.muted, flexShrink: 0 }}>{q.pct}%</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Progress({ pct, done, total }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 64, background: BRAND.paper, borderRadius: 4, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#16A34A' : BRAND.blue }} />
      </div>
      <span style={{ fontSize: 12.5, color: BRAND.muted, whiteSpace: 'nowrap' }}>{done}/{total}</span>
    </div>
  );
}

function Pill({ status, nextStep }) {
  const s = STATUS[status] || STATUS.empty;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{
        fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999,
        background: s.bg, color: s.ink, border: '1px solid ' + s.border, whiteSpace: 'nowrap',
      }}>
        {s.label}
      </span>
      {nextStep && NEXT_STEP[nextStep] && (
        <span style={{ fontSize: 11.5, color: BRAND.muted, whiteSpace: 'nowrap' }}>{NEXT_STEP[nextStep]}</span>
      )}
    </span>
  );
}

const TH = { padding: '9px 12px', fontSize: 12, fontWeight: 600, color: BRAND.muted };
const TD = { padding: '9px 12px', color: BRAND.ink };
