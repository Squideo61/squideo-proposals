// Marketing → Email. Three mailing lists, a composer, and what happened after
// you pressed send.
//
// The screen is deliberately ordered the way the job runs: who you could email
// (the list cards), what you've sent (the table), then — once you open one —
// how it did. The list cards are first because the count is the number worth
// checking before writing anything, and it's the only one that can surprise you
// (unsubscribes and staff addresses come off it).
//
// Sending is a queue on the server, so this view polls while a campaign is in
// flight rather than holding a request open.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, BarChart3, Check, Clock, Eye, Mail, MousePointerClick, Pause, Play,
  Plus, Send, Trash2, Users, UserCheck, UserPlus, X, AlertTriangle, Link2, Ban, Inbox, Search,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal, ResponsiveTable } from '../ui.jsx';
import { RichTextEditor, RichTextToolbar } from './EmailComposer.jsx';
import { sanitizeEmailHtml, isHtmlEmpty } from '../../lib/emailHtml.js';

const LISTS = [
  {
    key: 'everyone', label: 'Everyone', icon: Users,
    blurb: 'Every contact and lead-magnet signup we hold an address for.',
  },
  {
    key: 'customers', label: 'Customers', icon: UserCheck,
    blurb: "People at organisations with a deal that's signed, paid or on retainer.",
  },
  {
    key: 'non_customers', label: 'Non-customers', icon: UserPlus,
    blurb: "Everyone who hasn't bought yet — enquiries, quotes, video-guide and brief-builder signups.",
  },
];
const listLabel = (k) => LISTS.find((l) => l.key === k)?.label || k;

// Where someone stands with us, as one badge. Four states rather than a tick
// box because they mean different things to whoever is about to press send: an
// explicit tick is evidence, a soft opt-in is a judgement we're making, an
// unsubscribe is a door closed, and a bounce is an address that no longer works.
const CONSENT = {
  opted_in:     { label: 'Opted in',     bg: '#ECFDF5', ink: '#15803D', border: '#A7F3D0' },
  soft:         { label: 'Soft opt-in',  bg: '#F1F5F9', ink: BRAND.muted, border: BRAND.border },
  unsubscribed: { label: 'Unsubscribed', bg: '#FEF2F2', ink: '#B91C1C', border: '#FECACA' },
  bounced:      { label: 'Bounced',      bg: '#FFF8EB', ink: '#B45309', border: '#F5C26B' },
  invalid:      { label: 'Bad address',  bg: '#FEF2F2', ink: '#B91C1C', border: '#FECACA' },
};

function ConsentBadge({ person }) {
  const c = CONSENT[person.status] || CONSENT.soft;
  const title = person.status === 'opted_in'
    ? `Ticked the marketing box${person.consentSource ? ' on the ' + person.consentSource + ' form' : ''}`
      + `${person.consentAt ? ' on ' + fmtDate(person.consentAt) : ''}`
      + `${person.consentText ? `\n“${person.consentText}”` : ''}`
    : person.status === 'soft'
      ? 'No explicit tick — on the list under the B2B soft opt-in, and can opt out of any email'
      : person.status === 'unsubscribed'
        ? `Unsubscribed${person.unsubscribedAt ? ' on ' + fmtDate(person.unsubscribedAt) : ''}`
          + `${person.unsubscribedFrom ? ' via ' + person.unsubscribedFrom : ''}`
        : person.status === 'invalid'
          ? 'That is not a working email address — it would bounce, so it is off every list until it is corrected'
          : 'Their mail server rejected us — the address is off every list';
  return (
    <span title={title} style={{
      whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
      background: c.bg, color: c.ink, border: '1px solid ' + c.border,
    }}>{c.label}</span>
  );
}

// The tags a sender can drop into the subject or body. Mirrors MERGE_TAGS in
// api/_lib/crm/campaignHtml.js — the server does the substituting.
const MERGE_TAGS = [
  { tag: '{{first_name|there}}', label: 'First name' },
  { tag: '{{name}}', label: 'Full name' },
  { tag: '{{company|your team}}', label: 'Company' },
];

const STATUS_STYLE = {
  draft:     { label: 'Draft',     bg: '#F1F5F9', ink: BRAND.muted, border: BRAND.border },
  scheduled: { label: 'Scheduled', bg: '#EFF6FF', ink: '#1D4ED8',   border: '#BFDBFE' },
  sending:   { label: 'Sending',   bg: '#FFF8EB', ink: '#B45309',   border: '#F5C26B' },
  sent:      { label: 'Sent',      bg: '#ECFDF5', ink: '#15803D',   border: '#A7F3D0' },
  paused:    { label: 'Paused',    bg: '#FFF8EB', ink: '#B45309',   border: '#F5C26B' },
  cancelled: { label: 'Cancelled', bg: '#FEF2F2', ink: '#B91C1C',   border: '#FECACA' },
};

const num = (n) => (Number(n) || 0).toLocaleString('en-GB');
const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
// "in about 40 minutes" reads better than a timestamp for something imminent,
// and the timestamp is given alongside it for anyone planning around it.
const untilLabel = (iso) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 60000) return 'any moment';
  const plural = (n, word) => `in about ${n} ${word}${n === 1 ? '' : 's'}`;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return plural(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.round(hours / 24), 'day');
};
const fmtClock = (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const fmtDateTime = (d) => (d
  ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.draft;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11.5,
      fontWeight: 700, background: s.bg, color: s.ink, border: '1px solid ' + s.border,
    }}>{s.label}</span>
  );
}

// ── the tab ─────────────────────────────────────────────────────────────────
export function CampaignsTab({ onOpenContact }) {
  const { showMsg } = useStore();
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);          // { campaigns, counts }
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);      // campaign being viewed/edited
  const [editing, setEditing] = useState(false);
  // { list, status } — which list card is open, and which slice of it.
  const [listPreview, setListPreview] = useState(null);
  const [harvesting, setHarvesting] = useState(false);

  const load = useCallback(() => (
    api.get('/api/crm/campaigns')
      .then((d) => { setData(d); setError(null); return d; })
      .catch((e) => { setError(e.message); return null; })
  ), []);

  useEffect(() => { load(); }, [load]);

  // Anything mid-flight keeps the list refreshing, so the sent count climbs on
  // screen instead of needing a manual reload. A running mailbox sweep counts
  // too — its progress is on this screen now.
  const harvest = data?.harvest || null;
  const sweeping = !!harvest && (harvest.status === 'listing' || harvest.status === 'working');
  const inFlight = (data?.campaigns || []).some((c) => c.status === 'sending') || sweeping;
  useEffect(() => {
    if (!inFlight || openId) return undefined;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [inFlight, openId, load]);

  const newCampaign = async () => {
    try {
      const created = await api.post('/api/crm/campaigns', { name: 'Untitled campaign', audience: 'everyone' });
      await load();
      setOpenId(created.id);
      setEditing(true);
    } catch (e) { showMsg(e.message || 'Could not create the campaign'); }
  };

  if (openId) {
    return (
      <CampaignDetail
        campaignId={openId}
        startEditing={editing}
        counts={data?.counts || null}
        onClose={() => { setOpenId(null); setEditing(false); load(); }}
        onOpenContact={onOpenContact}
        // A duplicate opens straight into its own editor — the point of
        // copying one is to change it.
        onOpenCampaign={(id) => { setOpenId(id); setEditing(true); load(); }}
      />
    );
  }

  const campaigns = data?.campaigns || [];

  return (
    <div>
      {/* Mailing lists */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        {LISTS.map((l) => {
          const Icon = l.icon;
          const count = data?.counts?.[l.key];
          return (
            <button
              key={l.key}
              onClick={() => setListPreview({ list: l.key, status: 'mailable' })}
              style={{
                flex: '1 1 230px', minWidth: 0, textAlign: 'left', cursor: 'pointer',
                background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12,
                padding: '14px 16px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Icon size={15} color={BRAND.blue} />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {l.label}
                </span>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: BRAND.ink, lineHeight: 1 }}>
                {count == null ? '—' : num(count)}
              </div>
              <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 6, lineHeight: 1.45 }}>{l.blurb}</div>
            </button>
          );
        })}

        {/* Off the list. Shown as a card of its own rather than a footnote: an
            unsubscribe applies to everything we send, so somebody who opts out
            of one email silently disappears from all three lists above. That
            has to be somewhere you can look at, not just a smaller number. */}
        <button
          onClick={() => setListPreview({ list: 'everyone', status: 'unsubscribed' })}
          style={{
            flex: '1 1 230px', minWidth: 0, textAlign: 'left', cursor: 'pointer',
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12,
            padding: '14px 16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Ban size={15} color="#B91C1C" />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Opted out
            </span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: BRAND.ink, lineHeight: 1 }}>
            {data?.counts ? num(data.counts.suppressed) : '—'}
          </div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 6, lineHeight: 1.45 }}>
            Unsubscribed or bounced — off every list, whichever email they left through.
          </div>
        </button>
      </div>

      <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 22, lineHeight: 1.5 }}>
        Lists are built live from contacts and lead-magnet signups, minus our own @squideo addresses.
        {data?.counts?.optedIn != null && (
          <> <strong>{num(data.counts.optedIn)}</strong> of them ticked a marketing box; the rest are on the
          B2B soft opt-in. Open any list to see which is which.</>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: BRAND.ink }}>Campaigns</h2>
        <div style={{ flex: 1 }} />
        {/* A sweep runs for minutes in the background, so its state belongs
            here rather than only inside the window that started it. */}
        <button
          className="btn-secondary" onClick={() => setHarvesting(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
        >
          <Inbox size={15} />
          {sweeping
            ? `Sweeping Gmail… ${harvest.percent == null ? '' : harvest.percent + '%'}`
            : 'Find enquirers in Gmail'}
        </button>
        <button className="btn-primary" onClick={newCampaign} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Plus size={15} /> New campaign
        </button>
      </div>

      {error && (
        <div style={{ padding: 14, border: '1px solid #FECACA', background: '#FEF2F2', borderRadius: 10, color: '#B91C1C', fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* Where a sweep got to, on the page you'd already be looking at. Stays
          after it finishes so the result isn't only visible to whoever happened
          to have the window open at the moment it ended. */}
      {harvest && harvest.status !== 'cancelled' && (
        <button
          onClick={() => setHarvesting(true)}
          style={{
            display: 'flex', width: '100%', textAlign: 'left', gap: 12, alignItems: 'center', flexWrap: 'wrap',
            padding: '11px 14px', marginBottom: 14, cursor: 'pointer', borderRadius: 10,
            border: '1px solid ' + (sweeping ? '#F5C26B' : (harvest.status === 'failed' ? '#FECACA' : '#A7F3D0')),
            background: sweeping ? '#FFF8EB' : (harvest.status === 'failed' ? '#FEF2F2' : '#ECFDF5'),
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: sweeping ? '#B45309' : (harvest.status === 'failed' ? '#B91C1C' : '#15803D') }}>
            {sweeping
              ? (harvest.status === 'listing'
                ? 'Gmail sweep — finding every matching message…'
                : `Gmail sweep — read ${num(harvest.processed)} of ${num(harvest.listed)}`)
              : harvest.status === 'failed'
                ? `Gmail sweep stopped: ${harvest.error || 'something went wrong'}`
                : 'Gmail sweep finished'}
          </span>
          <span style={{ fontSize: 12.5, color: BRAND.muted }}>
            {harvest.mode === 'quote_forms'
              ? `${num(harvest.imported)} quote requests recovered`
              : `${num(harvest.processed)} messages read`}
            {sweeping ? ' so far · carry on, it keeps going in the background' : ' · open to see who it found'}
          </span>
          {sweeping && (
            <span style={{ flex: '1 1 120px', minWidth: 100, height: 6, borderRadius: 999, background: 'white', overflow: 'hidden', border: '1px solid ' + BRAND.border }}>
              <span style={{
                display: 'block', height: '100%', background: BRAND.blue,
                width: (harvest.percent == null ? 8 : harvest.percent) + '%', transition: 'width .5s ease',
              }} />
            </span>
          )}
        </button>
      )}

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 4 }}>
        <ResponsiveTable
          keyField="id"
          onRowClick={(row) => { setOpenId(row.id); setEditing(row.status === 'draft'); }}
          empty="No campaigns yet. Press “New campaign” to write one."
          columns={[
            { key: 'name', label: 'Campaign', render: (r) => (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: BRAND.ink }}>{r.name}</div>
                <div style={{ fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.subject || 'No subject yet'}
                </div>
              </div>
            ) },
            { key: 'audience', label: 'List', render: (r) => listLabel(r.audience) },
            { key: 'status', label: 'Status', render: (r) => (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <StatusPill status={r.status} />
                {r.status === 'sending' && r.stats && (
                  <span style={{ fontSize: 11.5, color: BRAND.muted }}>
                    {num(r.stats.sent)}/{num(r.stats.total)}
                  </span>
                )}
              </span>
            ) },
            { key: 'sent', label: 'Sent', align: 'right', render: (r) => num(r.stats?.sent) },
            { key: 'openRate', label: 'Opened', align: 'right', render: (r) => (
              r.stats?.sent ? <span title={`${num(r.stats.opened)} people · ${num(r.stats.opens)} opens`}>{pct(r.stats.openRate)}</span> : '—'
            ) },
            { key: 'clickRate', label: 'Clicked', align: 'right', render: (r) => (
              r.stats?.sent ? <span title={`${num(r.stats.clicked)} people · ${num(r.stats.clicks)} clicks`}>{pct(r.stats.clickRate)}</span> : '—'
            ) },
            { key: 'when', label: 'Date', align: 'right', hideOnMobile: true, render: (r) => (
              <span style={{ fontSize: 12.5, color: BRAND.muted }}>
                {fmtDateTime(r.completedAt || r.startedAt || r.scheduledAt || r.createdAt)}
              </span>
            ) },
          ]}
          rows={campaigns}
        />
      </div>

      {harvesting && <GmailHarvestModal onClose={() => { setHarvesting(false); load(); }} />}

      {listPreview && (
        <ListPreviewModal
          listKey={listPreview.list}
          initialStatus={listPreview.status}
          onClose={() => { setListPreview(null); load(); }}
          onOpenContact={onOpenContact}
        />
      )}
    </div>
  );
}

// ── who's actually on a list ────────────────────────────────────────────────
// A count nobody can inspect is a count nobody trusts, and this is the last
// chance to notice that a list is full of people it shouldn't be.
function ListPreviewModal({ listKey, initialStatus = 'mailable', onClose, onOpenContact }) {
  const { showMsg } = useStore();
  const [list, setList] = useState(listKey);
  const [status, setStatus] = useState(initialStatus);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);
  const [confirmBack, setConfirmBack] = useState(null); // person being put back on
  const [fixing, setFixing] = useState(false);
  const [fixReport, setFixReport] = useState(null);

  useEffect(() => {
    setData(null);
    api.get(`/api/crm/campaigns/audience?list=${encodeURIComponent(list)}&status=${encodeURIComponent(status)}`)
      .then(setData).catch((e) => setError(e.message));
  }, [list, status, reload]);

  const b = data?.breakdown;
  const TABS = [
    ['mailable', 'On the list', b?.mailable],
    ['opted_in', 'Opted in', b?.optedIn],
    ['soft', 'Soft opt-in', b?.soft],
    ['unsubscribed', 'Unsubscribed', b?.unsubscribed],
    ['bounced', 'Bounced', b?.bounced],
    ['invalid', 'Bad addresses', b?.invalid],
  ];

  const fixAddresses = async () => {
    setFixing(true);
    try {
      const r = await api.post('/api/crm/campaigns/audience/fix-addresses', {});
      setFixReport(r);
      setReload((n) => n + 1);
      if (r.repaired?.length) showMsg(`Fixed ${r.repaired.length} address${r.repaired.length === 1 ? '' : 'es'}`);
    } catch (e) { showMsg(e.message || 'Could not check the addresses'); }
    finally { setFixing(false); }
  };

  const putBackOn = async (person) => {
    try {
      await api.post('/api/crm/campaigns/audience/resubscribe', { email: person.email });
      showMsg(`${person.email} is back on the list`);
      setConfirmBack(null);
      setReload((n) => n + 1);
    } catch (e) { showMsg(e.message || 'Could not do that'); }
  };

  return (
    <Modal onClose={onClose} maxWidth={720}>
      <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: BRAND.ink }}>{listLabel(list)}</h3>
      <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 12 }}>
        {data ? `${num(data.total)} ${data.total === 1 ? 'person' : 'people'} would receive a campaign sent to this list` : 'Loading…'}
      </div>

      {/* Which list, so you can check the same person across all three without
          closing and reopening. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {LISTS.map((l) => (
          <button
            key={l.key} onClick={() => setList(l.key)}
            style={{
              padding: '3px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
              border: '1px solid ' + (list === l.key ? BRAND.ink : BRAND.border),
              background: list === l.key ? BRAND.ink : 'white',
              color: list === l.key ? 'white' : BRAND.ink, fontWeight: list === l.key ? 700 : 500,
            }}
          >{l.label}</button>
        ))}
      </div>

      {/* Standing. The last two tabs show people who are NOT on the list — the
          only place you can see that someone opted out of a different email and
          has therefore dropped off this one too. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map(([key, text, n]) => (
          <button
            key={key} onClick={() => setStatus(key)}
            style={{
              padding: '4px 11px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
              border: '1px solid ' + (status === key ? BRAND.blue : BRAND.border),
              background: status === key ? BRAND.blue : 'white',
              color: status === key ? 'white' : BRAND.ink, fontWeight: status === key ? 700 : 500,
            }}
          >
            {text}{n != null && <span style={{ opacity: 0.75 }}> {num(n)}</span>}
          </button>
        ))}
      </div>

      {error && <div style={{ color: '#B91C1C', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {(status === 'unsubscribed' || status === 'bounced') && (
        <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 10, lineHeight: 1.5 }}>
          {status === 'unsubscribed'
            ? 'These people are off every marketing list, whichever email they unsubscribed through — an opt-out applies to everything we send, not just the campaign it came from. Only put someone back on if they have asked you to.'
            : 'Their mail server rejected us. Sending again risks our whole domain being marked as spam, so they stay off until the address is known to work.'}
        </div>
      )}

      {status === 'invalid' && (
        <div style={{
          fontSize: 12, color: BRAND.ink, marginBottom: 10, lineHeight: 1.55,
          background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 12px',
        }}>
          These aren't working addresses — mostly ones where the label text ran into the address while reading an old
          notification email (<code>…@gmail.comphone</code>). They're off every list, because an address like that can
          only bounce. Fixing them reads the original email again where there is one, and repairs the rest where the
          answer is obvious.
          <div style={{ marginTop: 8 }}>
            <button className="btn-primary" onClick={fixAddresses} disabled={fixing}>
              {fixing ? 'Checking…' : 'Check and fix addresses'}
            </button>
          </div>
          {fixReport && (
            <div style={{ marginTop: 8, fontSize: 12, color: BRAND.muted, lineHeight: 1.55 }}>
              Checked {num(fixReport.checked)} · fixed <strong style={{ color: '#15803D' }}>{num(fixReport.repaired?.length || 0)}</strong>
              {fixReport.unusable?.length ? <> · {num(fixReport.unusable.length)} still need a human</> : null}
              {fixReport.more ? ' · more to do, press it again' : ''}
            </div>
          )}
        </div>
      )}

      <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 10 }}>
        {(data?.sample || []).map((p) => (
          <div
            key={p.email}
            style={{
              display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px',
              borderBottom: '1px solid ' + BRAND.paper, fontSize: 13, flexWrap: 'wrap',
            }}
          >
            <span
              onClick={p.contactId && onOpenContact ? () => { onClose(); onOpenContact(p.contactId); } : undefined}
              style={{
                fontWeight: 600, color: BRAND.ink, minWidth: 0, flex: '1 1 auto', wordBreak: 'break-word',
                cursor: p.contactId && onOpenContact ? 'pointer' : 'default',
              }}
            >
              {p.name || p.email}
              {p.name && <span style={{ color: BRAND.muted, fontSize: 12, fontWeight: 400 }}> · {p.email}</span>}
              {p.companyName && <span style={{ color: BRAND.muted, fontSize: 12, fontWeight: 400 }}> · {p.companyName}</span>}
              {/* Said in words, not just a colour: which email lost them, and
                  when. That is the whole question this screen answers. */}
              {p.unsubscribedAt && (
                <div style={{ fontSize: 11.5, color: '#B91C1C', marginTop: 2 }}>
                  Left {fmtDate(p.unsubscribedAt)}{p.unsubscribedFrom ? ` · via ${p.unsubscribedFrom}` : ''}
                </div>
              )}
              {p.status === 'opted_in' && p.consentAt && (
                <div style={{ fontSize: 11.5, color: '#15803D', marginTop: 2 }}>
                  Ticked the marketing box {fmtDate(p.consentAt)}{p.consentSource ? ` · ${p.consentSource} form` : ''}
                </div>
              )}
              {/* How we came by them. The question behind every other one on
                  this screen, and the answer to "why is this person here?". */}
              {p.lastEnquiryAt && (
                <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>
                  Asked us for a quote {fmtDate(p.lastEnquiryAt)}
                </div>
              )}
            </span>
            {p.isCustomer && (
              <span style={{ fontSize: 10.5, fontWeight: 700, color: '#15803D', background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' }}>
                Customer
              </span>
            )}
            <ConsentBadge person={p} />
            {p.status === 'unsubscribed' && (
              <button
                className="btn-ghost" onClick={() => setConfirmBack(p)}
                style={{ fontSize: 11.5, padding: '2px 8px', border: '1px solid ' + BRAND.border, borderRadius: 999 }}
              >
                Put back on
              </button>
            )}
          </div>
        ))}
        {data && !data.sample?.length && (
          <div style={{ padding: 20, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
            {status === 'unsubscribed' ? 'Nobody has unsubscribed.' : status === 'bounced' ? 'No bounces.' : 'Nobody on this list yet.'}
          </div>
        )}
        {data && data.shown > (data.sample?.length || 0) && (
          <div style={{ padding: '10px 12px', fontSize: 12, color: BRAND.muted, textAlign: 'center' }}>
            Showing the first {num(data.sample.length)} of {num(data.shown)}.
          </div>
        )}
      </div>

      {confirmBack && (
        <Modal onClose={() => setConfirmBack(null)} maxWidth={420}>
          <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 700, color: BRAND.ink }}>
            Put {confirmBack.email} back on the list?
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: 13.5, color: BRAND.ink, lineHeight: 1.55 }}>
            They opted out{confirmBack.unsubscribedAt ? ` on ${fmtDate(confirmBack.unsubscribedAt)}` : ''}
            {confirmBack.unsubscribedFrom ? ` via ${confirmBack.unsubscribedFrom}` : ''}. Only do this if they have
            asked to start receiving our emails again — undoing someone else's opt-out is what turns a marketing email
            into a complaint.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn-secondary" onClick={() => setConfirmBack(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => putBackOn(confirmBack)}>They asked — put them back on</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

// ── one campaign: composer + report ─────────────────────────────────────────
function CampaignDetail({ campaignId, startEditing, counts, onClose, onOpenContact, onOpenCampaign }) {
  const { showMsg } = useStore();
  const isMobile = useIsMobile();
  const [state, setState] = useState(null);        // { campaign, stats, links, recipients }
  const [editing, setEditing] = useState(!!startEditing);
  const [error, setError] = useState(null);

  const load = useCallback(() => (
    api.get('/api/crm/campaigns/' + campaignId)
      .then((d) => { setState(d); setError(null); return d; })
      .catch((e) => { setError(e.message); return null; })
  ), [campaignId]);

  useEffect(() => { load(); }, [load]);

  const status = state?.campaign?.status;
  useEffect(() => {
    if (status !== 'sending') return undefined;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [status, load]);

  if (error && !state) {
    return (
      <div>
        <button className="btn-ghost" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={16} /> Back
        </button>
        <div style={{ marginTop: 16, color: '#B91C1C', fontSize: 13 }}>{error}</div>
      </div>
    );
  }
  if (!state) return <div style={{ padding: 30, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>Loading…</div>;

  const { campaign } = state;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 8px' }}>
          <ArrowLeft size={16} /> All campaigns
        </button>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: BRAND.ink, minWidth: 0 }}>{campaign.name}</h2>
        <StatusPill status={campaign.status} />
        <div style={{ flex: 1 }} />
        {!editing && (campaign.status === 'draft' || campaign.status === 'scheduled') && (
          <button className="btn-secondary" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>

      {editing
        ? (
          <CampaignEditor
            campaign={campaign}
            counts={counts}
            onSaved={(c) => { setState((s) => ({ ...s, campaign: c })); }}
            onDone={() => { setEditing(false); load(); }}
            onDeleted={onClose}
          />
        )
        : (
          <CampaignReport
            state={state}
            onReload={load}
            onOpenContact={onOpenContact}
            isMobile={isMobile}
            showMsg={showMsg}
            // A reopened campaign is a draft again — drop straight into editing
            // it, which is what reopening was for.
            onReopened={() => setEditing(true)}
            onOpenCampaign={onOpenCampaign}
          />
        )}
    </div>
  );
}

// ── composer ────────────────────────────────────────────────────────────────
function CampaignEditor({ campaign, counts, onSaved, onDone, onDeleted }) {
  const { showMsg } = useStore();
  const isMobile = useIsMobile();
  const editorRef = useRef(null);
  const [name, setName] = useState(campaign.name);
  const [audience, setAudience] = useState(campaign.audience);
  const [subject, setSubject] = useState(campaign.subject);
  const [preheader, setPreheader] = useState(campaign.preheader || '');
  const [body, setBody] = useState(campaign.bodyHtml || '');
  const [replyTo, setReplyTo] = useState(campaign.replyTo || '');
  const [hourlyCap, setHourlyCap] = useState(campaign.hourlyCap ?? SEND_SPEEDS[0].hourlyCap);
  const [dailyCap, setDailyCap] = useState(campaign.dailyCap ?? SEND_SPEEDS[0].dailyCap);
  const [excluding, setExcluding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const imageInputRef = useRef(null);
  const [exclusions, setExclusions] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(null);
  const [testing, setTesting] = useState(false);

  const mark = (setter) => (v) => { setter(v); setDirty(true); };

  const payload = () => ({
    name, audience, subject, preheader,
    // rich: a campaign may carry headings, images and the table-based CTA
    // button; the strict set would quietly flatten all three.
    bodyHtml: sanitizeEmailHtml(body, { rich: true }),
    replyTo: replyTo || null,
    hourlyCap, dailyCap,
  });

  const speed = speedOf({ hourlyCap, dailyCap });

  // How many are actually left after exclusions — the number on the button
  // has to be the number that receives it.
  useEffect(() => {
    api.get(`/api/crm/campaigns/${campaign.id}/exclusions`).then(setExclusions).catch(() => {});
  }, [campaign.id]);

  const save = async ({ quiet = false } = {}) => {
    setSaving(true);
    try {
      const saved = await api.patch('/api/crm/campaigns/' + campaign.id, payload());
      onSaved(saved);
      setDirty(false);
      if (!quiet) showMsg('Campaign saved');
      return saved;
    } catch (e) {
      showMsg(e.message || 'Could not save');
      return null;
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    // Saved first, always: a test of the last saved version rather than what's
    // on screen is worse than useless — it looks like a check and isn't one.
    const saved = await save({ quiet: true });
    if (!saved) { setTesting(false); return; }
    try {
      const r = await api.post(`/api/crm/campaigns/${campaign.id}/test`, {});
      showMsg('Test sent to ' + r.to);
    } catch (e) { showMsg(e.message || 'Test send failed'); }
    finally { setTesting(false); }
  };

  const openPreview = async () => {
    const saved = await save({ quiet: true });
    if (!saved) return;
    try {
      const r = await api.post(`/api/crm/campaigns/${campaign.id}/preview`, payload());
      setPreview(r);
    } catch (e) { showMsg(e.message || 'Could not build the preview'); }
  };

  const remove = async () => {
    try {
      await api.delete('/api/crm/campaigns/' + campaign.id);
      onDeleted();
    } catch (e) { showMsg(e.message || 'Could not delete'); }
  };

  // Drop the branded starter back into an emptied draft. Written straight into
  // the editor element as well as into state — the contentEditable seeds itself
  // once on mount, so setting state alone would leave the box looking empty.
  const applyTemplate = async () => {
    try {
      const { bodyHtml } = await api.get('/api/crm/campaigns/template');
      if (editorRef.current) editorRef.current.innerHTML = bodyHtml;
      setBody(bodyHtml);
      setDirty(true);
    } catch (e) { showMsg(e.message || 'Could not load the template'); }
  };

  // Upload an image and drop it into the body at the cursor.
  //
  // It has to become a hosted URL, not a data: URI: every mail client strips
  // those, so an image that looks right in the composer would arrive as a
  // broken box for everyone. `max-width:100%` because the one thing a campaign
  // image must not do is force a horizontal scrollbar on a phone.
  const pickImage = () => imageInputRef.current?.click();
  const uploadImage = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const res = await fetch(`/api/crm/campaigns/${campaign.id}/image`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': file.type, 'x-filename': encodeURIComponent(file.name) },
        body: file,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      const el = editorRef.current;
      if (el) {
        el.focus();
        const img = `<img src="${json.url}" alt="" style="max-width:100%;height:auto;display:block;margin:8px 0;">`;
        if (!document.execCommand('insertHTML', false, img)) el.innerHTML += img;
        setBody(el.innerHTML);
        setDirty(true);
      }
    } catch (e) { showMsg(e.message || 'Could not upload that image'); }
    finally { setUploading(false); }
  };

  const insertTag = (tag) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    document.execCommand('insertText', false, tag);
    setBody(el.innerHTML);
    setDirty(true);
  };

  // The audience minus anyone left out. Falls back to the raw list count until
  // the exclusions load, so the figure never reads high once they have.
  const recipientCount = exclusions && exclusions.audienceTotal != null
    ? exclusions.willReceive
    : counts?.[audience];
  const ready = subject.trim() && !isHtmlEmpty(body);

  const label = { fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 6 };
  const input = { width: '100%', padding: '9px 11px', border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 14, color: BRAND.ink, background: 'white' };

  return (
    <div style={{ display: 'flex', gap: 18, flexDirection: isMobile ? 'column' : 'row', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 auto', minWidth: 0, width: '100%' }}>
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
            <div style={{ flex: '2 1 260px', minWidth: 0 }}>
              <label style={label}>Campaign name <span style={{ textTransform: 'none', fontWeight: 500 }}>(internal only)</span></label>
              <input style={input} value={name} onChange={(e) => mark(setName)(e.target.value)} />
            </div>
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <label style={label}>Send to</label>
              <select style={input} value={audience} onChange={(e) => mark(setAudience)(e.target.value)}>
                {LISTS.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}{counts?.[l.key] != null ? ` — ${num(counts[l.key])} people` : ''}
                  </option>
                ))}
              </select>
              <div style={{ marginTop: 6, fontSize: 12, color: BRAND.muted }}>
                {exclusions?.excluded?.length
                  ? <>Leaving out <strong style={{ color: '#B45309' }}>{num(exclusions.excluded.length)}</strong> · </>
                  : null}
                <button
                  className="btn-ghost" onClick={() => setExcluding(true)}
                  style={{ fontSize: 12, padding: 0, color: BRAND.blue, textDecoration: 'underline' }}
                >
                  {exclusions?.excluded?.length ? 'Edit who' : 'Leave someone out'}
                </button>
              </div>
            </div>
          </div>

          {/* Send speed. Sits with the audience because it's part of the same
              decision: who it goes to, and how hard that lands. */}
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Send speed</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SEND_SPEEDS.map((s) => {
                const active = speed.key === s.key;
                return (
                  <button
                    key={s.key} onClick={() => { setHourlyCap(s.hourlyCap); setDailyCap(s.dailyCap); setDirty(true); }}
                    title={s.hint}
                    style={{
                      padding: '5px 12px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
                      border: '1px solid ' + (active ? BRAND.blue : BRAND.border),
                      background: active ? BRAND.blue : 'white',
                      color: active ? 'white' : BRAND.ink, fontWeight: active ? 700 : 500,
                    }}
                  >{s.label}</button>
                );
              })}
            </div>
            <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 6, lineHeight: 1.5 }}>
              {speed.hint} {recipientCount != null && <>Sending to {num(recipientCount)} would take {paceEstimate(recipientCount, speed)}.</>}
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={label}>Subject</label>
            <input
              style={input} value={subject} placeholder="The line that decides whether it gets opened"
              onChange={(e) => mark(setSubject)(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={label}>Preview text <span style={{ textTransform: 'none', fontWeight: 500 }}>(the grey line next to the subject)</span></label>
            <input
              style={input} value={preheader} placeholder="Optional — but it's the second thing people read"
              onChange={(e) => mark(setPreheader)(e.target.value)}
            />
          </div>

          <label style={label}>Message</label>
          <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
            <RichTextEditor
              editorRef={editorRef}
              initialHtml={campaign.bodyHtml || ''}
              onChange={(html) => { setBody(html); setDirty(true); }}
              minHeight={220}
              maxHeight={560}
            />
            <RichTextToolbar
              editorRef={editorRef}
              onChange={(html) => { setBody(html); setDirty(true); }}
              onInsertImage={uploading ? undefined : pickImage}
            />
          </div>

          <input
            ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadImage(f); }}
          />
          {uploading && (
            <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 6 }}>Uploading image…</div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            {/* Only offered once the box is empty. A one-click "reset" sitting
                next to a finished draft is a way to lose an afternoon's
                writing, and there's no undo across a reload. */}
            {isHtmlEmpty(body) && (
              <button
                className="btn-ghost" onClick={applyTemplate}
                style={{ fontSize: 12, padding: '3px 9px', border: '1px solid ' + BRAND.blue, borderRadius: 999, color: BRAND.blue, fontWeight: 600 }}
              >
                Start from the Squideo template
              </button>
            )}
            <span style={{ fontSize: 12, color: BRAND.muted }}>Personalise:</span>
            {MERGE_TAGS.map((t) => (
              <button
                key={t.tag} className="btn-ghost" onClick={() => insertTag(t.tag)}
                style={{ fontSize: 12, padding: '3px 9px', border: '1px solid ' + BRAND.border, borderRadius: 999 }}
                title={`Inserts ${t.tag} — the text after the | is used when we don't know it`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={label}>Replies go to</label>
            <input
              style={{ ...input, maxWidth: 340 }} value={replyTo} placeholder="enquiries@squideo.co.uk (default)"
              onChange={(e) => mark(setReplyTo)(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn-secondary" onClick={() => save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button className="btn-secondary" onClick={openPreview} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Eye size={15} /> Preview
          </button>
          <button className="btn-secondary" onClick={sendTest} disabled={testing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Mail size={15} /> {testing ? 'Sending…' : 'Send test to me'}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={remove} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#B91C1C' }}>
            <Trash2 size={15} /> Delete
          </button>
          <button
            className="btn-primary"
            disabled={!ready}
            title={ready ? '' : 'Add a subject and some copy first'}
            onClick={async () => { const saved = await save({ quiet: true }); if (saved) setConfirming(true); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
          >
            <Send size={15} /> Review &amp; send
          </button>
        </div>

        {dirty && (
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 8 }}>Unsaved changes.</div>
        )}
      </div>

      {/* What it does to the inbox, stated once, next to the thing it affects. */}
      <aside style={{
        flex: isMobile ? '1 1 auto' : '0 0 250px', width: isMobile ? '100%' : 250,
        background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 14,
        fontSize: 12.5, color: BRAND.muted, lineHeight: 1.55,
      }}>
        <div style={{ fontWeight: 700, color: BRAND.ink, marginBottom: 8, fontSize: 13 }}>Before you send</div>
        <p style={{ margin: '0 0 10px' }}>
          Going to <strong style={{ color: BRAND.ink }}>{recipientCount == null ? '…' : num(recipientCount)}</strong> {' '}
          {listLabel(audience).toLowerCase()} — one email each, addressed individually. Nobody sees anyone else.
        </p>
        <p style={{ margin: '0 0 10px' }}>
          An unsubscribe footer and one-click opt-out header are added automatically. Anyone who opts out is off every
          future list within seconds.
        </p>
        <p style={{ margin: 0 }}>
          Opens and clicks are tracked per person, so the report tells you who to ring — not just a percentage.
        </p>
      </aside>

      {excluding && (
        <ExclusionsModal
          campaignId={campaign.id}
          audience={audience}
          onChanged={setExclusions}
          onClose={() => setExcluding(false)}
        />
      )}
      {confirming && (
        <SendConfirmModal
          campaignId={campaign.id}
          audience={audience}
          excluded={exclusions?.excluded?.length || 0}
          speed={speed}
          onClose={() => setConfirming(false)}
          onSent={() => { setConfirming(false); onDone(); }}
        />
      )}
      {preview && (
        <Modal onClose={() => setPreview(null)} maxWidth={720}>
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 4 }}>Subject</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: BRAND.ink, marginBottom: 14 }}>{preview.subject || '(no subject)'}</div>
          <iframe
            title="Email preview"
            srcDoc={preview.html}
            sandbox=""
            style={{ width: '100%', height: '60vh', border: '1px solid ' + BRAND.border, borderRadius: 8, background: 'white' }}
          />
        </Modal>
      )}
    </div>
  );
}

// Leaving individuals out of one send.
//
// Distinct from unsubscribing, and the wording works hard to keep them apart:
// an unsubscribe is the recipient's decision and applies to everything we ever
// send, where this is the sender's and applies to this campaign only. Confusing
// the two either emails someone who asked you not to, or quietly drops someone
// from every future list because of a one-off.
//
// Search runs server-side across the whole list — picking one person out of
// four thousand is the entire job, and filtering the visible page can't do it.
function ExclusionsModal({ campaignId, audience, onClose, onChanged }) {
  const { showMsg } = useStore();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [state, setState] = useState(null);   // { excluded, audienceTotal, willReceive }
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const loadExclusions = useCallback(() => (
    api.get(`/api/crm/campaigns/${campaignId}/exclusions`)
      .then((d) => { setState(d); onChanged?.(d); return d; })
      .catch(() => null)
  ), [campaignId, onChanged]);

  useEffect(() => { loadExclusions(); }, [loadExclusions]);

  // Debounced, and says so. The searching flag is set the moment a keystroke
  // lands rather than when the request goes out, because the gap between typing
  // and any visible reaction is exactly the part that felt broken.
  //
  // Late responses are dropped: type "amy" quickly and three requests are in
  // flight, which without this can finish out of order and leave the results
  // for "am" on screen under the word "amy".
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); setSearching(false); return undefined; }
    setSearching(true);
    let live = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.get(`/api/crm/campaigns/audience?list=${encodeURIComponent(audience)}&q=${encodeURIComponent(term)}`)
        .then((d) => { if (live) { setResults(d); setSearching(false); } })
        .catch((e) => { if (live) { setSearching(false); showMsg(e.message || 'Search failed'); } });
    }, 200);
    return () => { live = false; clearTimeout(timer.current); };
  }, [q, audience, showMsg]);

  const excludedSet = new Set((state?.excluded || []).map((e) => e.email));

  const exclude = async (person) => {
    setBusy(true);
    try {
      await api.post(`/api/crm/campaigns/${campaignId}/exclusions`, { email: person.email });
      await loadExclusions();
    } catch (e) { showMsg(e.message || 'Could not exclude them'); }
    finally { setBusy(false); }
  };

  const include = async (email) => {
    setBusy(true);
    try {
      await api.delete(`/api/crm/campaigns/${campaignId}/exclusions?email=${encodeURIComponent(email)}`);
      await loadExclusions();
    } catch (e) { showMsg(e.message || 'Could not put them back'); }
    finally { setBusy(false); }
  };

  const excludeOpenDeals = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/crm/campaigns/${campaignId}/exclusions`, { group: 'open_deals' });
      await loadExclusions();
      showMsg(r.added ? `Left out ${num(r.added)} with live deals` : 'Already left out');
    } catch (e) { showMsg(e.message || 'Could not exclude them'); }
    finally { setBusy(false); }
  };

  const excludeAllShown = async () => {
    const people = (results?.sample || []).filter((p) => !excludedSet.has(p.email));
    if (!people.length) return;
    setBusy(true);
    try {
      await api.post(`/api/crm/campaigns/${campaignId}/exclusions`, { emails: people.map((p) => p.email) });
      await loadExclusions();
    } catch (e) { showMsg(e.message || 'Could not exclude them'); }
    finally { setBusy(false); }
  };

  const row = {
    display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px',
    borderBottom: '1px solid ' + BRAND.paper, fontSize: 13, flexWrap: 'wrap',
  };

  return (
    <Modal onClose={onClose} maxWidth={640}>
      <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: BRAND.ink }}>Leave people out</h3>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.55 }}>
        For this campaign only — it doesn't unsubscribe anyone or affect any other send.
        {state && <> Currently going to <strong style={{ color: BRAND.ink }}>{num(state.willReceive)}</strong> of {num(state.audienceTotal)}.</>}
      </p>

      {/* The one group a blanket offer can actively damage: someone in the
          middle of being quoted. Offered as a button because doing it by hand
          means searching for people you'd have to already know were there. */}
      {state?.openDeals?.total > 0 && (
        <div style={{
          background: '#FFF8EB', border: '1px solid #F5C26B', borderRadius: 10,
          padding: '10px 12px', marginBottom: 12, display: 'flex', gap: 12,
          alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 12.5, color: BRAND.ink, lineHeight: 1.5, flex: '1 1 240px' }}>
            <strong>{num(state.openDeals.total)}</strong> {state.openDeals.total === 1 ? 'person' : 'people'} on this
            list {state.openDeals.total === 1 ? 'has' : 'have'} a live deal in the pipeline
            {state.openDeals.sample?.length > 0 && (
              <span style={{ color: BRAND.muted }}>
                {' '}— {state.openDeals.sample.slice(0, 3).map((d) => d.name || d.email).join(', ')}
                {state.openDeals.total > 3 ? ` and ${num(state.openDeals.total - 3)} more` : ''}
              </span>
            )}.
            {state.openDeals.remaining === 0 && <strong style={{ color: '#B45309' }}> All already left out.</strong>}
          </span>
          {state.openDeals.remaining > 0 && (
            <button className="btn-secondary" disabled={busy} onClick={excludeOpenDeals}>
              Leave out {num(state.openDeals.remaining)}
            </button>
          )}
        </div>
      )}

      <div style={{ position: 'relative', marginBottom: 10 }}>
        <input
          value={q} onChange={(e) => setQ(e.target.value)} autoFocus
          placeholder="Search the list by name, email or company"
          style={{
            width: '100%', padding: '9px 11px', paddingRight: 96,
            border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 14,
            boxSizing: 'border-box',
          }}
        />
        {/* Inside the box, where the eye already is. A spinner further down the
            page is one people don't look at. */}
        {searching && (
          <span style={{
            position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)',
            fontSize: 12, color: BRAND.muted, pointerEvents: 'none',
          }}>Searching…</span>
        )}
      </div>

      {/* Nothing found yet, but something IS happening. */}
      {searching && !results && (
        <div style={{ padding: '14px 0', fontSize: 12.5, color: BRAND.muted }}>
          Looking through {state?.audienceTotal ? num(state.audienceTotal) : 'the'} {state?.audienceTotal ? 'people' : 'list'}…
        </div>
      )}

      {results && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: BRAND.muted }}>
              {results.shown === 0 ? 'Nobody matches that.' : `${num(results.shown)} ${results.shown === 1 ? 'match' : 'matches'}`}
              {results.shown > results.sample.length && ` · showing ${num(results.sample.length)}`}
            </span>
            {results.sample.length > 1 && (
              <button className="btn-ghost" onClick={excludeAllShown} disabled={busy}
                style={{ fontSize: 12, padding: '2px 9px', border: '1px solid ' + BRAND.border, borderRadius: 999 }}>
                Exclude all {num(results.sample.length)}
              </button>
            )}
          </div>
          {/* Results stay put while the next search runs, dimmed rather than
              blanked — a list that empties on every keystroke reads as "no
              matches" when it means "still looking". */}
          <div style={{
            maxHeight: '32vh', overflowY: 'auto', border: '1px solid ' + BRAND.border,
            borderRadius: 10, marginBottom: 16,
            opacity: searching ? 0.5 : 1, transition: 'opacity .15s ease',
          }}>
            {results.sample.map((p) => {
              const already = excludedSet.has(p.email);
              return (
                <div key={p.email} style={row}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, color: BRAND.ink }}>{p.name || p.email}</span>
                    {p.name && <span style={{ color: BRAND.muted, fontSize: 12 }}> · {p.email}</span>}
                    {p.companyName && <span style={{ color: BRAND.muted, fontSize: 12 }}> · {p.companyName}</span>}
                  </span>
                  {already
                    ? <span style={{ fontSize: 11.5, fontWeight: 700, color: '#B45309' }}>Excluded</span>
                    : (
                      <button className="btn-ghost" onClick={() => exclude(p)} disabled={busy}
                        style={{ fontSize: 12, padding: '2px 9px', border: '1px solid ' + BRAND.border, borderRadius: 999 }}>
                        Exclude
                      </button>
                    )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>
        Excluded from this send ({num(state?.excluded?.length || 0)})
      </div>
      <div style={{ maxHeight: '28vh', overflowY: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 10 }}>
        {(state?.excluded || []).map((e) => (
          <div key={e.email} style={row}>
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
              {e.email}
              {/* Why, not just who — six addresses with no reason is a list
                  nobody can review a month later. */}
              {e.reason && (
                <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>{e.reason}</div>
              )}
            </span>
            <button className="btn-ghost" onClick={() => include(e.email)} disabled={busy}
              style={{ fontSize: 12, padding: '2px 9px', border: '1px solid ' + BRAND.border, borderRadius: 999 }}>
              Put back
            </button>
          </div>
        ))}
        {!state?.excluded?.length && (
          <div style={{ padding: 16, textAlign: 'center', color: BRAND.muted, fontSize: 12.5 }}>
            Nobody's excluded — everyone on the list gets it.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// How fast a campaign is allowed to go out.
//
// The presets exist because "500 an hour" is not a decision anyone can make
// without knowing what a mailbox provider thinks of them — where "spread it
// over a fortnight because we've never done this before" is.
const SEND_SPEEDS = [
  {
    key: 'warmup', label: 'Warm up', hourlyCap: 40, dailyCap: 300,
    hint: 'About 300 a day. The right choice for a first big send from a domain that has never done marketing — a slow start is what builds the reputation everything later depends on.',
  },
  {
    key: 'steady', label: 'Steady', hourlyCap: 150, dailyCap: 1500,
    hint: 'About 1,500 a day. Once a few sends have gone out cleanly and bounces are low.',
  },
  {
    key: 'full', label: 'All at once', hourlyCap: null, dailyCap: null,
    hint: 'As fast as the sender allows, roughly 300 a minute. Only for a list you have emailed before without trouble.',
  },
];

const speedOf = (c) => SEND_SPEEDS.find((s) => s.hourlyCap === (c.hourlyCap || null)
  && s.dailyCap === (c.dailyCap || null)) || SEND_SPEEDS[0];

// How long a list takes at a given speed — the number that makes a cap feel
// like a decision rather than a restriction.
function paceEstimate(count, speed) {
  if (!speed.dailyCap || !count) return 'about 15 minutes';
  const days = Math.ceil(count / speed.dailyCap);
  if (days <= 1) return 'under a day';
  return `about ${days} days`;
}

// The last gate. Shows the real recipient count fetched fresh (not the one
// cached when the page loaded) — this is the one number that must not be stale,
// because it's the one the sender is agreeing to.
function SendConfirmModal({ campaignId, audience, excluded = 0, speed = null, onClose, onSent }) {
  const { showMsg } = useStore();
  const [audienceData, setAudienceData] = useState(null);
  const [when, setWhen] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.get('/api/crm/campaigns/audience?list=' + encodeURIComponent(audience))
      .then(setAudienceData).catch(() => setAudienceData(null));
  }, [audience]);

  const go = async () => {
    setSending(true);
    try {
      const r = await api.post(`/api/crm/campaigns/${campaignId}/send`, when ? { scheduledAt: new Date(when).toISOString() } : {});
      showMsg(r.scheduled ? 'Scheduled' : `Sending to ${num(r.queued)} people`);
      onSent();
    } catch (e) {
      showMsg(e.message || 'Could not start the send');
      setSending(false);
    }
  };

  const total = audienceData?.total == null ? null : Math.max(0, audienceData.total - excluded);

  return (
    <Modal onClose={onClose} maxWidth={460}>
      <h3 style={{ margin: '0 0 10px', fontSize: 17, fontWeight: 700, color: BRAND.ink }}>Send this campaign?</h3>
      <p style={{ margin: '0 0 10px', fontSize: 14, color: BRAND.ink, lineHeight: 1.55 }}>
        It goes to <strong>{total == null ? '…' : num(total)}</strong> {listLabel(audience).toLowerCase()}
        {' '}— people who haven't unsubscribed, excluding our own addresses
        {excluded > 0 && <> and the <strong>{num(excluded)}</strong> you left out</>}.
        {speed && speed.dailyCap
          ? <> At the <strong>{speed.label.toLowerCase()}</strong> speed it'll go out over {paceEstimate(total || 0, speed)},
              a few hundred a day — you can watch it and stop at any point.</>
          : <> This can't be undone once it starts, though you can pause it part-way.</>}
      </p>

      {/* The consent split, at the moment it matters most. Not a warning — just
          the basis you're sending on, stated before you commit rather than
          after somebody complains. */}
      {audienceData?.breakdown && (
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.55 }}>
          <strong style={{ color: '#15803D' }}>{num(audienceData.breakdown.optedIn)}</strong> ticked a marketing box;
          {' '}<strong>{num(audienceData.breakdown.soft)}</strong> are on the B2B soft opt-in.
          {audienceData.breakdown.unsubscribed > 0 && (
            <> {num(audienceData.breakdown.unsubscribed)} previously unsubscribed {audienceData.breakdown.unsubscribed === 1 ? 'person is' : 'people are'} already excluded.</>
          )}
        </p>
      )}

      <label style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 6 }}>
        Send later (optional)
      </label>
      <input
        type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
        style={{ width: '100%', padding: '9px 11px', border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 14, marginBottom: 18 }}
      />

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={go} disabled={sending || total === 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {when ? <Clock size={15} /> : <Send size={15} />}
          {sending ? 'Starting…' : (when ? 'Schedule' : `Send to ${total == null ? '' : num(total)}`)}
        </button>
      </div>
    </Modal>
  );
}

// ── report ──────────────────────────────────────────────────────────────────
function CampaignReport({ state, onReload, onOpenContact, isMobile, showMsg, onReopened, onOpenCampaign }) {
  const { campaign, stats, links, pace, bounceTracking } = state;
  const [filter, setFilter] = useState('all');
  const [recipients, setRecipients] = useState(state.recipients || []);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setRecipients(state.recipients || []); }, [state.recipients]);

  const shown = useMemo(() => {
    if (filter === 'opened') return recipients.filter((r) => r.opens > 0);
    if (filter === 'clicked') return recipients.filter((r) => r.clicks > 0);
    if (filter === 'unopened') return recipients.filter((r) => r.status === 'sent' && r.opens === 0);
    if (filter === 'failed') return recipients.filter((r) => r.status === 'failed' || r.status === 'skipped');
    if (filter === 'unsubscribed') return recipients.filter((r) => r.unsubscribed);
    return recipients;
  }, [recipients, filter]);

  const control = async (action) => {
    setBusy(true);
    try {
      await api.post(`/api/crm/campaigns/${campaign.id}/${action}`, {});
      await onReload();
      if (action === 'reopen') onReopened?.();
    } catch (e) { showMsg(e.message || 'That did not work'); }
    finally { setBusy(false); }
  };

  const changeSpeed = async (speed) => {
    setBusy(true);
    try {
      await api.post(`/api/crm/campaigns/${campaign.id}/speed`, {
        hourlyCap: speed.hourlyCap, dailyCap: speed.dailyCap,
      });
      await onReload();
      showMsg(`Now sending at "${speed.label}"`);
    } catch (e) { showMsg(e.message || 'Could not change the speed'); }
    finally { setBusy(false); }
  };

  const duplicate = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/crm/campaigns/${campaign.id}/duplicate`, {});
      showMsg(r.alreadySent
        ? `Copied — the ${num(r.alreadySent)} who already had it are left out`
        : 'Copied to a new draft');
      onOpenCampaign?.(r.campaign.id);
    } catch (e) { showMsg(e.message || 'Could not duplicate it'); }
    finally { setBusy(false); }
  };

  const progress = stats?.total ? Math.round(((stats.sent + stats.failed + stats.skipped) / stats.total) * 100) : 0;

  return (
    <div>
      {/* Live progress while the queue drains. */}
      {(campaign.status === 'sending' || campaign.status === 'paused') && (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>
              {campaign.status === 'paused' ? 'Paused' : 'Sending'} — {num(stats?.sent)} of {num(stats?.total)}
            </span>
            <div style={{ flex: 1 }} />
            {campaign.status === 'sending'
              ? <button className="btn-secondary" disabled={busy} onClick={() => control('pause')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Pause size={14} /> Pause</button>
              : <button className="btn-primary" disabled={busy} onClick={() => control('resume')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Play size={14} /> Resume</button>}
            <button className="btn-ghost" disabled={busy} onClick={() => control('cancel')} style={{ color: '#B91C1C', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Ban size={14} /> Stop
            </button>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: BRAND.paper, overflow: 'hidden' }}>
            <div style={{ width: progress + '%', height: '100%', background: BRAND.blue, transition: 'width .4s ease' }} />
          </div>

          {/* A throttled campaign spends most of its life waiting, which from
              the outside is indistinguishable from one that has stopped. */}
          {pace && (
            <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 8, lineHeight: 1.55 }}>
              {pace.nextBatchAt
                ? <>Waiting on the {pace.sentLastHour >= (pace.hourlyCap || Infinity) ? 'hourly' : 'daily'} limit —
                    next batch <strong style={{ color: BRAND.ink }}>{untilLabel(pace.nextBatchAt)}</strong>
                    {' '}(around {fmtClock(pace.nextBatchAt)}).</>
                : <>Next batch is due <strong style={{ color: BRAND.ink }}>within a minute</strong>
                    {pace.nextBatchSize > 0 && <> — up to {num(pace.nextBatchSize)} at a time</>}.</>}
              {pace.perDay && <> Sending up to <strong>{num(pace.perDay)}</strong> a day
                {pace.hourlyCap ? <> ({num(pace.hourlyCap)} an hour)</> : null}.</>}
              {pace.finishAt && <> On course to finish <strong>{fmtDay(pace.finishAt)}</strong>.</>}

              {/* Changing speed mid-send is safe and often what you want: the
                  first batches are the evidence you didn't have when you chose.
                  Raising the cap frees the difference straight away. */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <span style={{ fontSize: 12 }}>Change speed:</span>
                {SEND_SPEEDS.map((s) => {
                  const active = (pace.hourlyCap || null) === s.hourlyCap && (pace.dailyCap || null) === s.dailyCap;
                  return (
                    <button
                      key={s.key} disabled={busy || active} title={s.hint}
                      onClick={() => changeSpeed(s)}
                      style={{
                        padding: '3px 10px', borderRadius: 999, fontSize: 12,
                        cursor: active ? 'default' : 'pointer',
                        border: '1px solid ' + (active ? BRAND.blue : BRAND.border),
                        background: active ? BRAND.blue : 'white',
                        color: active ? 'white' : BRAND.ink, fontWeight: active ? 700 : 500,
                      }}
                    >{s.label}</button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* A cancelled campaign was a dead end: the work was still there but
          there was no way back to it. Which way forward depends entirely on
          whether anybody actually received it. */}
      {campaign.status === 'cancelled' && (
        <div style={{
          background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 12,
          padding: 14, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 13.5, color: BRAND.ink, lineHeight: 1.5 }}>
            {stats?.sent
              ? <>Cancelled after <strong>{num(stats.sent)}</strong> {stats.sent === 1 ? 'person' : 'people'} received it.
                  Editing now would mean two versions of the same email — duplicate it instead and they'll be left out
                  of the copy.</>
              : <>Cancelled before anything went out, so nothing was lost — reopen it to carry on editing.</>}
          </span>
          <div style={{ flex: 1 }} />
          {!stats?.sent && (
            <button className="btn-primary" disabled={busy} onClick={() => control('reopen')}>
              Reopen and edit
            </button>
          )}
          <button className="btn-secondary" disabled={busy} onClick={duplicate}>
            Duplicate
          </button>
        </div>
      )}

      {/* A finished campaign is the other place people want to start from. */}
      {campaign.status === 'sent' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn-secondary" disabled={busy} onClick={duplicate}>
            Duplicate for a follow-up
          </button>
        </div>
      )}

      {campaign.status === 'scheduled' && (
        <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 12, padding: 14, marginBottom: 16, fontSize: 13.5, color: '#1D4ED8', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Clock size={16} />
          <span>Goes out {fmtDateTime(campaign.scheduledAt)}. The list is worked out at that moment, so anyone added between now and then is included.</span>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" disabled={busy} onClick={() => control('cancel')}>Cancel send</button>
        </div>
      )}

      {/* Headline numbers. Rate first, headcount underneath — the percentage is
          what you compare between campaigns, the count is what makes it real. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <Tile icon={Send} label="Sent" value={num(stats?.sent)} hint={stats?.failed ? `${num(stats.failed)} failed` : (stats?.queued ? `${num(stats.queued)} to go` : 'delivered to the mail servers')} />
        <Tile icon={Eye} label="Opened" value={pct(stats?.openRate)} hint={`${num(stats?.opened)} people · ${num(stats?.opens)} opens`} good={stats?.openRate >= 25} />
        <Tile icon={MousePointerClick} label="Clicked" value={pct(stats?.clickRate)} hint={`${num(stats?.clicked)} people · ${num(stats?.clicks)} clicks`} good={stats?.clickRate >= 3} />
        <Tile icon={BarChart3} label="Click-to-open" value={pct(stats?.clickToOpenRate)} hint="of those who read it, who acted" />
        <Tile icon={X} label="Unsubscribed" value={pct(stats?.unsubscribeRate)} hint={`${num(stats?.unsubscribed)} ${stats?.unsubscribed === 1 ? 'person' : 'people'}`} bad={stats?.unsubscribeRate >= 0.5} />
        {/* The two numbers mailbox providers judge the domain on. Shown even at
            zero: their absence is the reassuring part, and a rate you only see
            once it's bad is a rate you find out about too late. */}
        {/* A rate of 0.0% and "we aren't being told" look identical, and the
            difference decides whether it's safe to send faster. So when the
            webhook isn't wired up, these say so instead of showing a number
            that would be believed. */}
        <Tile
          icon={AlertTriangle} label="Bounced"
          value={bounceTracking === false ? 'Not tracked' : pct(stats?.bounceRate)}
          hint={bounceTracking === false
            ? 'Set RESEND_WEBHOOK_SECRET to see real bounces — check Resend’s dashboard meanwhile'
            : `${num(stats?.bounced)} dead ${stats?.bounced === 1 ? 'address' : 'addresses'} · keep under 2%`}
          bad={bounceTracking !== false && stats?.bounceRate >= 2}
          muted={bounceTracking === false}
        />
        <Tile
          icon={Ban} label="Spam reports"
          value={bounceTracking === false ? 'Not tracked' : pct(stats?.complaintRate)}
          hint={bounceTracking === false
            ? 'Complaints aren’t reaching the CRM, so nobody is being suppressed'
            : `${num(stats?.complaints)} · Google's limit is 0.3%`}
          bad={bounceTracking !== false && stats?.complaintRate >= 0.3}
          muted={bounceTracking === false}
        />
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* What people clicked. */}
        <div style={{ flex: '1 1 300px', minWidth: 0, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Link2 size={15} color={BRAND.blue} />
            <span style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>Links clicked</span>
          </div>
          {links?.length ? links.map((l) => (
            <div key={l.url} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid ' + BRAND.paper }}>
              <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, color: BRAND.blue, wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{l.url}</a>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.ink, whiteSpace: 'nowrap' }}>
                {num(l.people)} {l.people === 1 ? 'person' : 'people'}
              </span>
            </div>
          )) : (
            <div style={{ fontSize: 12.5, color: BRAND.muted }}>
              No clicks yet{campaign.status === 'sent' ? '.' : ' — it only just went out.'}
            </div>
          )}
        </div>

        {/* Subject line, kept visible: the report is meaningless without the
            thing being measured. */}
        <div style={{ flex: '1 1 260px', minWidth: 0, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>What went out</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>{campaign.subject}</div>
          {campaign.preheader && <div style={{ fontSize: 12.5, color: BRAND.muted, marginBottom: 8 }}>{campaign.preheader}</div>}
          <div style={{ fontSize: 12.5, color: BRAND.muted }}>
            {listLabel(campaign.audience)} · {fmtDateTime(campaign.completedAt || campaign.startedAt)}
          </div>
        </div>
      </div>

      {/* Per-person engagement — the actionable half. */}
      <div style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginRight: 4 }}>Recipients</span>
          {[
            ['all', 'All', recipients.length],
            ['opened', 'Opened', recipients.filter((r) => r.opens > 0).length],
            ['clicked', 'Clicked', recipients.filter((r) => r.clicks > 0).length],
            ['unopened', 'Not opened', recipients.filter((r) => r.status === 'sent' && r.opens === 0).length],
            ['unsubscribed', 'Opted out since', recipients.filter((r) => r.unsubscribed).length],
            ['failed', 'Not delivered', recipients.filter((r) => r.status === 'failed' || r.status === 'skipped').length],
          ].map(([key, text, n]) => (
            <button
              key={key} onClick={() => setFilter(key)}
              style={{
                padding: '4px 11px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
                border: '1px solid ' + (filter === key ? BRAND.blue : BRAND.border),
                background: filter === key ? BRAND.blue : 'white',
                color: filter === key ? 'white' : BRAND.ink, fontWeight: filter === key ? 700 : 500,
              }}
            >
              {text} {n > 0 && <span style={{ opacity: 0.75 }}>{num(n)}</span>}
            </button>
          ))}
        </div>

        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 4 }}>
          <ResponsiveTable
            keyField="id"
            empty="Nobody in this group."
            onRowClick={onOpenContact ? (r) => r.contactId && onOpenContact(r.contactId) : undefined}
            columns={[
              { key: 'who', label: 'Person', render: (r) => (
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: BRAND.ink, display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                    {r.name || r.email}
                    {r.optedIn && !r.unsubscribed && (
                      <span title="Ticked the marketing box on a signup form" style={{ fontSize: 10.5, fontWeight: 700, color: '#15803D', background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 999, padding: '1px 7px' }}>
                        Opted in
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: BRAND.muted, wordBreak: 'break-all' }}>
                    {r.companyName || r.email}
                  </div>
                  {/* Whether THIS email lost them or a different one did. Same
                      badge either way would invite the wrong conclusion about
                      the campaign you're currently judging. */}
                  {r.unsubscribed && (
                    <div style={{ fontSize: 11.5, color: '#B91C1C', marginTop: 2 }}>
                      {r.unsubscribedHere ? 'Unsubscribed from this email' : 'Since unsubscribed'}
                      {r.unsubscribedAt ? ` · ${fmtDate(r.unsubscribedAt)}` : ''}
                      {!r.unsubscribedHere && r.unsubscribedFrom ? ` · via ${r.unsubscribedFrom}` : ''}
                    </div>
                  )}
                </div>
              ) },
              { key: 'opens', label: 'Opens', align: 'right', render: (r) => (
                r.opens > 0
                  ? <span style={{ fontWeight: 700, color: '#15803D' }}>{num(r.opens)}</span>
                  : <span style={{ color: BRAND.muted }}>—</span>
              ) },
              { key: 'clicks', label: 'Clicks', align: 'right', render: (r) => (
                r.clicks > 0
                  ? <span style={{ fontWeight: 700, color: BRAND.blue }}>{num(r.clicks)}</span>
                  : <span style={{ color: BRAND.muted }}>—</span>
              ) },
              { key: 'firstOpenAt', label: 'First opened', align: 'right', hideOnMobile: true, render: (r) => (
                <span style={{ fontSize: 12.5, color: BRAND.muted }}>{fmtDateTime(r.firstOpenAt)}</span>
              ) },
              { key: 'where', label: 'Where', align: 'right', hideOnMobile: true, render: (r) => (
                <span style={{ fontSize: 12.5, color: BRAND.muted }}>
                  {[r.city, r.country].filter(Boolean).join(', ') || '—'}
                </span>
              ) },
              { key: 'status', label: 'Status', align: 'right', render: (r) => (
                r.status === 'sent'
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: '#15803D' }}><Check size={13} /> Sent</span>
                  : r.status === 'skipped'
                    ? <span title={r.error || ''} style={{ fontSize: 12.5, color: BRAND.muted }}>Skipped</span>
                    : r.status === 'failed'
                      ? <span title={r.error || ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: '#B91C1C' }}><AlertTriangle size={13} /> Failed</span>
                      : <span style={{ fontSize: 12.5, color: BRAND.muted }}>Queued</span>
              ) },
            ]}
            rows={shown}
          />
        </div>
      </div>
    </div>
  );
}

// ── finding people who only exist in the mailbox ────────────────────────────
// Someone who emailed years ago asking about a video is a real enquiry, and
// their address is nowhere in the CRM — only in Gmail. This searches for that
// mail and offers up who it finds.
//
// It is a SEARCH AND A REVIEW, not a scrape, and the screen is built to make
// that obvious. A blanket harvest of a mailbox collects suppliers, the
// accountant, recruiters and a great many robots; the soft opt-in only covers
// an address given while asking us about work. So every candidate arrives with
// the evidence — the subject line they wrote, when, how often — and nothing is
// added until somebody ticks it.
function GmailHarvestModal({ onClose }) {
  const { showMsg } = useStore();
  const [presets, setPresets] = useState([]);
  const [query, setQuery] = useState('');
  // 'quote_forms' reads the enquiry out of the email body; 'people' harvests
  // whoever sent it. Set by whichever preset you pick.
  const [mode, setMode] = useState('quote_forms');
  const [ingest, setIngest] = useState(true);
  const [state, setState] = useState(null);   // { run, people, counts, total }
  const [starting, setStarting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [touched, setTouched] = useState(false); // has the user changed the ticks?

  const load = useCallback(() => (
    api.get('/api/crm/campaigns/harvest/run')
      .then((d) => { setState(d); return d; })
      .catch((e) => { setError(e.message); return null; })
  ), []);

  useEffect(() => {
    api.get('/api/crm/campaigns/harvest')
      .then((d) => {
        setPresets(d.presets || []);
        if (d.presets?.length) {
          setQuery((q) => q || d.presets[0].query);
          setMode(d.presets[0].mode || 'people');
        }
      })
      .catch((e) => setError(e.message));
    load();
  }, [load]);

  const run = state?.run || null;
  const running = run && (run.status === 'listing' || run.status === 'working');

  // While the sweep works, keep pulling — a big mailbox takes minutes, and the
  // count climbing is the difference between "working" and "hung".
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  // Pre-tick the people we don't already hold, until the user starts choosing
  // for themselves — after that their choices are never overwritten by a poll.
  useEffect(() => {
    if (touched || !state?.people) return;
    setPicked(new Set(state.people.filter((p) => p.known === 'new').map((p) => p.email)));
  }, [state, touched]);

  const start = async () => {
    setStarting(true); setError(null); setTouched(false);
    try {
      const d = await api.post('/api/crm/campaigns/harvest', { query, ingest, mode });
      setState(d);
    } catch (e) { setError(e.message || 'Could not start the sweep'); }
    finally { setStarting(false); }
  };

  const stop = async () => {
    try { await api.post('/api/crm/campaigns/harvest/stop', {}); await load(); }
    catch (e) { showMsg(e.message || 'Could not stop it'); }
  };

  const toggle = (email) => {
    setTouched(true);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  };

  const importPicked = async () => {
    const people = (state?.people || []).filter((p) => picked.has(p.email));
    if (!people.length) return;
    setImporting(true);
    try {
      const r = await api.post('/api/crm/campaigns/harvest/import', { people, runId: run?.id });
      const bits = [];
      if (r.added) bits.push(`${num(r.added)} added`);
      if (r.updated) bits.push(`${num(r.updated)} confirmed`);
      if (r.skipped?.length) bits.push(`${num(r.skipped.length)} skipped`);
      showMsg(bits.join(' · ') || 'Nothing to do');
      setTouched(false);
      await load();
    } catch (e) { showMsg(e.message || 'Import failed'); }
    finally { setImporting(false); }
  };

  const KNOWN = {
    new: { label: 'New', bg: '#ECFDF5', ink: '#15803D', border: '#A7F3D0' },
    on_list: { label: 'Already have them', bg: '#F1F5F9', ink: BRAND.muted, border: BRAND.border },
    provisional: { label: 'Half-known', bg: '#EFF6FF', ink: '#1D4ED8', border: '#BFDBFE' },
    unsubscribed: { label: 'Unsubscribed', bg: '#FEF2F2', ink: '#B91C1C', border: '#FECACA' },
  };

  return (
    <Modal onClose={onClose} maxWidth={880}>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: BRAND.ink }}>Find enquirers in Gmail</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.55 }}>
        {mode === 'quote_forms'
          ? <>Reads the website’s old <strong>“New Quote Request”</strong> emails and pulls the enquiry out of each one —
              name, email, phone, company, brief, timeline and budget — straight into the CRM as a proper quote request.
              The sender on those emails is you, so the details have to come out of the body. Goes back as far as your
              mailbox does.</>
          : <>For people who just emailed rather than using the form. It reads your whole mailbox, however far back it
              goes, shows what each person actually wrote, and adds only the people you tick.</>}
      </p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {presets.map((p) => (
          <button
            key={p.key} onClick={() => { setQuery(p.query); setMode(p.mode || 'people'); }} title={p.hint} disabled={running}
            style={{
              padding: '4px 11px', borderRadius: 999, fontSize: 12.5, cursor: running ? 'default' : 'pointer',
              border: '1px solid ' + (query === p.query ? BRAND.blue : BRAND.border),
              background: query === p.query ? BRAND.blue : 'white',
              color: query === p.query ? 'white' : BRAND.ink, fontWeight: query === p.query ? 700 : 500,
              opacity: running ? 0.6 : 1,
            }}
          >{p.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          value={query} onChange={(e) => setQuery(e.target.value)} disabled={running}
          onKeyDown={(e) => { if (e.key === 'Enter' && query.trim() && !running) start(); }}
          placeholder="Gmail search, e.g. subject:(quote OR enquiry)"
          style={{
            flex: '1 1 320px', minWidth: 0, padding: '9px 11px', border: '1px solid ' + BRAND.border,
            borderRadius: 8, fontSize: 13.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        />
        {running
          ? <button className="btn-secondary" onClick={stop}>Stop</button>
          : (
            <button className="btn-primary" onClick={start} disabled={starting || !query.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Search size={15} /> {starting ? 'Starting…' : 'Sweep my mailbox'}
            </button>
          )}
      </div>

      {mode === 'quote_forms' && (
        <div style={{
          background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 10,
          padding: '10px 12px', fontSize: 12.5, color: '#15803D', lineHeight: 1.55, marginBottom: 8,
        }}>
          Every email this finds becomes a quote request automatically — no ticking required. They're filed as
          <strong> cleared</strong> rather than new, so hundreds of old enquiries don't bury today's, and the
          <strong> Opt In</strong> line in each email decides whether that person counts as having consented to
          marketing. Running it twice is safe: each email can only ever produce one quote request.
        </div>
      )}

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: BRAND.ink, marginBottom: 6, cursor: running ? 'default' : 'pointer' }}>
        <input type="checkbox" checked={ingest} disabled={running} onChange={(e) => setIngest(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          <strong>Also file these emails into the CRM.</strong>
          <span style={{ color: BRAND.muted }}>
            {' '}Each matching message is added to the Emails view exactly as if it had arrived today, and links itself
            to a deal where one matches — so the original enquiry is readable, not just the details read out of it.
            Slower, and it will bring in whatever else your search matches.
          </span>
        </span>
      </label>
      <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 14 }}>
        Anything Gmail's own search box accepts works here — no date limit is applied, so a sweep goes back as far as
        your mailbox does. Nothing is sent, changed or deleted in Gmail.
      </div>

      {error && (
        <div style={{ padding: 12, border: '1px solid #FECACA', background: '#FEF2F2', borderRadius: 10, color: '#B91C1C', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {run && (
        <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: running ? 8 : 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink }}>
              {run.status === 'listing' ? 'Finding every matching message…'
                : run.status === 'working' ? `Reading ${num(run.processed)} of ${num(run.listed)}`
                : run.status === 'done' ? `Finished — read ${num(run.processed)} messages`
                : run.status === 'cancelled' ? `Stopped after ${num(run.processed)} of ${num(run.listed)}`
                : `Stopped: ${run.error || 'something went wrong'}`}
            </span>
            <span style={{ fontSize: 12, color: BRAND.muted }}>
              {run.mode === 'quote_forms'
                ? <><strong style={{ color: '#15803D' }}>{num(run.imported)}</strong> quote requests pulled in</>
                : (run.ingest ? `${num(run.ingested)} filed into the CRM` : 'addresses only')}
              {run.mode === 'quote_forms' && run.ingest && ` · ${num(run.ingested)} emails filed`}
              {run.failed > 0 && ` · ${num(run.failed)} unreadable`}
            </span>
          </div>
          {running && (
            <div style={{ height: 8, borderRadius: 999, background: 'white', overflow: 'hidden', border: '1px solid ' + BRAND.border }}>
              <div style={{
                width: (run.percent == null ? 8 : run.percent) + '%', height: '100%',
                background: BRAND.blue, transition: 'width .5s ease',
                opacity: run.percent == null ? 0.5 : 1,
              }} />
            </div>
          )}
          {run.status === 'listing' && (
            <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 6 }}>
              {num(run.listed)} found so far. You can close this — the sweep carries on and the results will be here
              when you come back.
            </div>
          )}
        </div>
      )}

      {state?.people?.length > 0 && (
        <>
          <div style={{ fontSize: 12.5, color: BRAND.muted, marginBottom: 10, lineHeight: 1.5 }}>
            <strong style={{ color: BRAND.ink }}>{num(state.total)}</strong>{' '}
            {run?.mode === 'quote_forms'
              ? <>{state.total === 1 ? 'enquirer' : 'enquirers'} recovered — each one is now a quote request you can
                  open, qualify or turn into a deal</>
              : <>{state.total === 1 ? 'person' : 'people'} wrote to you</>}
            {state.counts.onList > 0 && run?.mode !== 'quote_forms' && <> · {num(state.counts.onList)} you already have</>}
            {state.counts.unsubscribed > 0 && <> · {num(state.counts.unsubscribed)} unsubscribed</>}
            {state.total > state.people.length && <> · showing the {num(state.people.length)} most recent</>}
            {run?.mode !== 'quote_forms' && '. Your own team, your sent mail, no-reply senders and the usual platforms are already filtered out.'}
          </div>

          <div style={{ maxHeight: '40vh', overflowY: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 10 }}>
            {state.people.map((c) => {
              const k = KNOWN[c.known] || KNOWN.new;
              const selectable = c.known === 'new' || c.known === 'provisional';
              return (
                <label
                  key={c.email}
                  style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px',
                    borderBottom: '1px solid ' + BRAND.paper, fontSize: 13,
                    cursor: selectable ? 'pointer' : 'default', opacity: selectable ? 1 : 0.65,
                  }}
                >
                  <input
                    type="checkbox" checked={picked.has(c.email)} disabled={!selectable}
                    onChange={() => toggle(c.email)} style={{ marginTop: 3 }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, color: BRAND.ink }}>{c.name || c.email}</span>
                    {c.name && <span style={{ color: BRAND.muted, fontSize: 12 }}> · {c.email}</span>}
                    {/* The evidence. Without it this is a list of strings; with
                        it, it's a decision someone can actually make. */}
                    <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2, wordBreak: 'break-word' }}>
                      “{c.lastSubject}” · {fmtDate(c.lastAt)}
                      {c.messages > 1 && ` · ${num(c.messages)} messages`}
                    </div>
                  </span>
                  <span style={{
                    whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
                    background: k.bg, color: k.ink, border: '1px solid ' + k.border,
                  }}>{k.label}</span>
                </label>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: BRAND.muted, marginRight: 'auto' }}>
              {run?.mode === 'quote_forms'
                ? 'Already in the CRM — find them under Quote Requests (filter: all), and on your mailing lists.'
                : `${num(picked.size)} ticked — they'll be added as contacts and land on the non-customers list.`}
            </span>
            <button className="btn-secondary" onClick={onClose}>Close</button>
            {run?.mode !== 'quote_forms' && (
              <button className="btn-primary" onClick={importPicked} disabled={importing || !picked.size}>
                {importing ? 'Adding…' : `Add ${num(picked.size)} ${picked.size === 1 ? 'person' : 'people'}`}
              </button>
            )}
          </div>
        </>
      )}

      {run && run.status === 'done' && !state?.people?.length && (
        <div style={{ padding: 20, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
          Nobody new in those messages.
        </div>
      )}
    </Modal>
  );
}

function Tile({ icon: Icon, label, value, hint, good, bad, muted }) {
  return (
    <div style={{
      flex: '1 1 150px', minWidth: 0, background: 'white',
      border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        <Icon size={14} color={BRAND.blue} />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      </div>
      <div style={{
        fontSize: muted ? 15 : 24, fontWeight: muted ? 700 : 800, lineHeight: muted ? 1.3 : 1,
        color: bad ? '#B91C1C' : (good ? '#15803D' : (muted ? BRAND.muted : BRAND.ink)),
      }}>{value}</div>
      {hint && <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 5, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}
