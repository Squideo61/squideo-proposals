// The video brief, as a shared page you can come back to.
//
// This replaces "download our Word template". A template is a document someone
// fills in alone with no prompts, and most never come back — we never even
// learn they tried. This autosaves every field, so an abandoned brief is still
// a visible, warm lead, and a finished one arrives as a real document.
//
// IT IS THE ORGANISATION'S BRIEF, NOT ONE PERSON'S. Nobody writes a video brief
// alone: it needs whoever owns the message, whoever knows the product and
// whoever holds the budget. Everyone with portal access edits the same
// document, changes are merged per question, every change is attributed, and
// anyone typing is shown on the question they're in so the next person picks a
// different one rather than the two of them overwriting each other.
//
// IT KNOWS WHAT JOB IT'S FOR. Built as a lead magnet, then clients started
// sending briefs after signing, for work already paid for. So a brief either
// names one of their projects or is a new enquiry, and finalising does the
// right thing for each.
//
// GROUPED SCREENS, NOT ONE QUESTION AT A TIME. The plan called for a Typeform-
// style one-per-screen flow; that works for eight consumer questions and is
// punishing across twenty-five B2B ones. Grouping into seven themed screens
// lets people scan ahead, skip what doesn't apply and answer the easy ones
// fast — and it makes the thing feel finite, which is what stops people
// bailing at question nine.
//
// Nothing here blocks on the network. Saves are debounced and fire-and-forget
// with a quiet status line; if one fails the answer stays in local state and
// goes up with the next keystroke.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText, ArrowRight, ArrowLeft, Check, Printer, Send, Plus, Trash2,
  Info, GraduationCap, ChevronDown, Lock, Users, History, Link2, Briefcase,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useIsMobile } from '../../utils.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState } from '../components.jsx';
import { navigate } from '../PortalApp.jsx';
import { GuideVideoModal } from '../GuideVideo.jsx';
import {
  StepProgress, TimeBadge, ReassuranceBadge, ResumeBanner, StepTitle, greeting,
} from '../ProgressChrome.jsx';
import {
  SCREENS, briefProgress, missingRequired, suggestedLength,
} from '../../../api/_lib/brief/questions.js';

// ═══ NOTHING THE CLIENT TYPES IS EVER LOST ═══════════════════════════════════
// Three layers, because each one covers what the others can't:
//
//  1. localStorage, on EVERY keystroke. Synchronous, can't fail, survives a
//     crashed tab, a flat battery or being offline on a train. This is the
//     literal "every keystroke saved".
//  2. A debounced PATCH to the server. Deliberately NOT per keystroke: that
//     would be dozens of requests per sentence, and requests that arrive out
//     of order lose data rather than saving it. It also flushes immediately
//     on blur, on tab-hide and on navigating away.
//  3. On load, if the local mirror is newer than what the server returned —
//     which means a save was in flight when they closed the tab — the local
//     copy wins and is pushed straight back up.
//
// The failure this prevents is someone spending twenty minutes on a brief,
// losing it, and never coming back. There is no version of that we can
// apologise our way out of.
const SAVE_DEBOUNCE_MS = 700;
// Keyed per brief now that an organisation can have several on the go — one
// shared key meant opening a second brief silently discarded the first one's
// unsent keystrokes.
const mirrorKey = (briefId) => `sq_brief_draft:${briefId}`;

const readMirror = (briefId) => {
  if (!briefId) return null;
  try {
    const raw = localStorage.getItem(mirrorKey(briefId));
    if (!raw) return null;
    const m = JSON.parse(raw);
    return m && m.briefId === briefId ? m : null;
  } catch { return null; }
};
const writeMirror = (briefId, answers) => {
  if (!briefId) return;
  try {
    localStorage.setItem(mirrorKey(briefId), JSON.stringify({ briefId, answers, at: Date.now() }));
  } catch { /* private mode / quota — the server save is still the real one */ }
};
const clearMirror = (briefId) => {
  try { localStorage.removeItem(mirrorKey(briefId)); } catch { /* ignore */ }
};

// How often an open brief checks in. Each tick both reports this tab as present
// and collects anything colleagues have changed, so it's one request rather
// than two — see briefTickRoute. Eight seconds is under the server's 50-second
// presence window several times over, so one dropped request never makes
// someone blink out of the "editing now" list.
const TICK_MS = 8000;

// Must agree with isEmpty() in api/_lib/brief/questions.js — if the client
// thinks a question is answered and the server doesn't, "Send" bounces with no
// visible reason.
const isBlank = (v) =>
  v == null ||
  (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && (v.length === 0 || v.every((r) => !r || (typeof r === 'object'
    ? !String(r.script || '').trim() && !String(r.visual || '').trim()
    : !String(r).trim()))));

const initials = (name) => String(name || '?')
  .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

// A stable colour per person, so the same colleague is the same colour on the
// question they're editing and in the "who's here" row.
const AVATAR_COLOURS = ['#2BB8E6', '#7C3AED', '#16A34A', '#F59E0B', '#EC4899', '#0EA5E9'];
const colourFor = (key) => {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
};

const relTime = (at) => {
  if (!at) return '';
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

// ── field chrome ─────────────────────────────────────────────────────────────
// 16px on phones is not a taste call: below it, iOS Safari zooms the page on
// focus and does not zoom back out. Across twenty-five questions that means
// pinching after every single field, which is enough on its own to lose the
// brief. Mirrors the .input rule in src/styles.css, which this page can't use
// because its fields are styled inline.
const inputStyle = (isMobile) => ({
  width: '100%', boxSizing: 'border-box', padding: '11px 13px',
  border: '1px solid #D8E0E8', borderRadius: 9, fontSize: isMobile ? 16 : 14.5,
  fontFamily: 'inherit', color: BRAND.ink, background: '#fff', lineHeight: 1.5,
});

function Avatar({ name, size = 24 }) {
  return (
    <span
      title={name}
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        background: colourFor(name), color: '#fff', fontSize: size * 0.42,
        fontWeight: 700, display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', letterSpacing: 0.2,
      }}
    >{initials(name)}</span>
  );
}

function WhyWeAsk({ text, videoRef, onWatch }) {
  if (!text && !videoRef) return null;
  return (
    <div style={{
      display: 'flex', gap: 8, marginTop: 8, padding: '9px 11px',
      background: '#F3F9FC', border: '1px solid #DCEBF3', borderRadius: 8,
      fontSize: 12.8, lineHeight: 1.55, color: '#5A7382',
    }}>
      <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: '#7FB6D0' }} />
      <div>
        {text}
        {videoRef && (
          <>
            {' '}
            <button
              type="button"
              /* Opens over the brief rather than navigating to #/course. Someone
                 mid-answer who gets taken to another page loses the question
                 they were thinking about, and coming back means finding their
                 place again. */
              onClick={() => onWatch?.(videoRef)}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: BRAND.blue, fontWeight: 600, fontSize: 12.8, fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 3,
              }}
            >
              <GraduationCap size={13} /> Watch video {videoRef}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Chips({ options, value, onChange, multi = false, disabled = false }) {
  const selected = multi ? (Array.isArray(value) ? value : []) : value;
  const isOn = (v) => (multi ? selected.includes(v) : selected === v);
  const toggle = (v) => {
    if (disabled) return;
    if (!multi) return onChange(selected === v ? null : v);
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => toggle(o.value)}
          style={{
            padding: '9px 14px', borderRadius: 999, cursor: disabled ? 'default' : 'pointer',
            fontSize: 13.5, fontFamily: 'inherit', fontWeight: isOn(o.value) ? 600 : 500,
            border: `1.5px solid ${isOn(o.value) ? BRAND.blue : '#D8E0E8'}`,
            background: isOn(o.value) ? '#EAF7FD' : '#fff',
            color: isOn(o.value) ? BRAND.ink : '#5A7382',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          {isOn(o.value) && <Check size={13} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// The two-column script/visuals table from the original PDF. Kept because it's
// the bit that makes this feel like their document rather than our form.
function ScriptTable({ value, onChange, disabled = false }) {
  const isMobile = useIsMobile();
  const inp = inputStyle(isMobile);
  const rows = Array.isArray(value) && value.length ? value : [{ script: '', visual: '' }];
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} style={{
          display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10,
          alignItems: 'flex-start',
        }}>
          {/* Side by side the two columns explain themselves and a placeholder
              on every row is just noise. Stacked on a phone they don't: row
              three would be two identical boxes with no way to tell which is
              the script and which is the visual. */}
          <textarea
            value={r.script || ''} rows={3} disabled={disabled}
            onChange={(e) => set(i, 'script', e.target.value)}
            placeholder={isMobile || i === 0 ? 'What is said…' : ''}
            style={{ ...inp, flex: '1 1 240px', resize: 'vertical' }}
          />
          <textarea
            value={r.visual || ''} rows={3} disabled={disabled}
            onChange={(e) => set(i, 'visual', e.target.value)}
            placeholder={isMobile || i === 0 ? 'What is on screen…' : ''}
            style={{ ...inp, flex: '1 1 240px', resize: 'vertical' }}
          />
          {rows.length > 1 && !disabled && (
            <button
              type="button" aria-label="Remove row"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#9AA5B1', padding: 8,
              }}
            ><Trash2 size={15} /></button>
          )}
        </div>
      ))}
      {!disabled && (
        <button
          type="button"
          onClick={() => onChange([...rows, { script: '', visual: '' }])}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 2,
            background: 'none', border: '1px dashed #C4D2DC', borderRadius: 8,
            padding: '8px 13px', cursor: 'pointer', color: '#5A7382',
            fontSize: 13, fontFamily: 'inherit',
          }}
        ><Plus size={14} /> Add a scene</button>
      )}
    </div>
  );
}

// "Tom is editing this" — the whole point of presence. Shown ON the question
// rather than only in a header row, because a list of names at the top of the
// page doesn't tell you the thing you need to know, which is whether the box
// you are about to type in is the one someone else is already in.
function EditingHere({ people }) {
  if (!people.length) return null;
  const names = people.map((p) => p.name);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 9,
      padding: '2px 9px 2px 3px', borderRadius: 999, background: '#FFF7ED',
      border: '1px solid #FED7AA', fontSize: 11.5, fontWeight: 600, color: '#B45309',
      verticalAlign: 'middle',
    }}>
      <Avatar name={names[0]} size={17} />
      {names.length === 1 ? `${names[0]} is editing this` : `${names.length} people are editing this`}
    </span>
  );
}

function Question({ q, value, onChange, onBlur, onFocus, answers, invalid, disabled, editors = [], onWatch }) {
  const isMobile = useIsMobile();
  const inp = inputStyle(isMobile);
  const suggestion = q.suggestFrom ? suggestedLength(answers) : null;
  // A field someone else is in is dimmed, not locked: two people typing in one
  // box is rare and recoverable (every version is in the activity feed), while
  // being locked out of your own brief is neither.
  const border = editors.length ? '#FDBA74' : (invalid ? '#E9A0A0' : '#D8E0E8');
  return (
    <div style={{ marginBottom: 26 }}>
      <label style={{
        display: 'block', fontSize: 14.5, fontWeight: 600, color: BRAND.ink,
        marginBottom: q.type === 'chips' || q.type === 'multi' ? 10 : 7, lineHeight: 1.4,
      }}>
        {q.label}
        {q.required && <span style={{ color: '#D14343', marginLeft: 4 }}>*</span>}
        <EditingHere people={editors} />
      </label>

      {/* onBlur saves immediately rather than waiting out the debounce — moving
          to the next question is the clearest signal that an answer is done. */}
      {q.type === 'text' && (
        <input
          type="text" value={value || ''} placeholder={q.placeholder || ''} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} onBlur={onBlur} onFocus={onFocus}
          style={{ ...inp, borderColor: border }}
        />
      )}
      {q.type === 'textarea' && (
        <textarea
          value={value || ''} rows={q.rows || 3} placeholder={q.placeholder || ''} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} onBlur={onBlur} onFocus={onFocus}
          style={{ ...inp, resize: 'vertical', borderColor: border }}
        />
      )}
      {(q.type === 'chips' || q.type === 'multi') && (
        <Chips
          options={q.options} value={value} onChange={(v) => { onFocus?.(); onChange(v); }}
          multi={q.type === 'multi'} disabled={disabled}
        />
      )}
      {q.type === 'scriptTable' && (
        <ScriptTable value={value} onChange={onChange} disabled={disabled} />
      )}

      {suggestion && isBlank(value) && !disabled && (
        <div style={{ marginTop: 9, fontSize: 13, color: '#5A7382' }}>
          Based on where you said it'll be seen, we'd suggest{' '}
          <button
            type="button" onClick={() => onChange(suggestion)}
            style={{
              background: '#EAF7FD', border: `1px solid ${BRAND.blue}`, borderRadius: 999,
              padding: '4px 11px', cursor: 'pointer', color: BRAND.ink,
              fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}
          >{q.options.find((o) => o.value === suggestion)?.label}</button>
        </div>
      )}

      <WhyWeAsk text={q.why} videoRef={q.videoRef} onWatch={onWatch} />
    </div>
  );
}

// ── who did what ─────────────────────────────────────────────────────────────
function ActivityFeed({ events, open, onToggle }) {
  const shown = open ? events : events.slice(0, 4);
  if (!events.length) return null;
  return (
    <Card style={{ marginTop: 18 }}>
      <button
        type="button" onClick={onToggle} aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: 0,
          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 13, fontWeight: 700, color: BRAND.ink, textAlign: 'left',
        }}
      >
        <History size={15} style={{ color: BRAND.blue }} />
        Activity
        <span style={{ color: '#9AA5B1', fontWeight: 500 }}>· {events.length}</span>
        <ChevronDown
          size={15}
          style={{ marginLeft: 'auto', color: '#9AA5B1', transform: open ? 'none' : 'rotate(-90deg)' }}
        />
      </button>
      <div style={{ marginTop: 12 }}>
        {shown.map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 9, padding: '7px 0', alignItems: 'flex-start' }}>
            <Avatar name={e.actorName} size={22} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: BRAND.ink, lineHeight: 1.45 }}>{e.text}</div>
              {e.summary && (
                <div style={{
                  fontSize: 12, color: '#6B7785', marginTop: 1,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{e.summary}</div>
              )}
            </div>
            <span style={{ fontSize: 11.5, color: '#9AA5B1', whiteSpace: 'nowrap' }}>{relTime(e.at)}</span>
          </div>
        ))}
        {!open && events.length > shown.length && (
          <button
            type="button" onClick={onToggle}
            style={{
              background: 'none', border: 'none', padding: '6px 0 0', cursor: 'pointer',
              color: BRAND.blue, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}
          >Show all {events.length}</button>
        )}
      </div>
    </Card>
  );
}

// ── the list ─────────────────────────────────────────────────────────────────
// What you land on when the organisation already has briefs. One per project
// plus one loose "new enquiry", which is the shape a client actually needs:
// they brief the job they've signed, and they brief the next one.
function BriefList({ data, onOpen, onCreate, onDelete, busy, manageMode }) {
  const [picking, setPicking] = useState(false);
  const briefs = data.briefs || [];
  const projects = data.projects || [];
  const usedDeals = new Set(briefs.filter((b) => !b.locked && b.dealId).map((b) => b.dealId));
  const hasLoose = briefs.some((b) => !b.locked && !b.dealId);
  // Staff are looking, not filling one in. Starting a brief on the client's
  // behalf is refused by the server (it would put our words under their name),
  // so don't offer it.
  const canCreate = !data.readOnly;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <FileText size={20} style={{ color: BRAND.blue }} />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: BRAND.ink }}>
          {data.readOnly ? 'Their video briefs' : 'Video briefs'}
        </h1>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: 14, lineHeight: 1.6, color: '#6B7785' }}>
        {data.readOnly
          ? 'Everything this organisation has briefed. Open one to read it and see who wrote what.'
          : 'Everyone on your team can work on these together — answers save as you type, and you\'ll see who changed what.'}
      </p>

      {briefs.map((b) => (
        // A row, not a button: the delete control has to be a sibling of the
        // open control rather than nested inside it.
        <div
          key={b.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
            background: '#fff', border: '1px solid #E8EEF3', borderRadius: 10,
            padding: '0 8px 0 0',
          }}
        >
          <button
            type="button" onClick={() => onOpen(b.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0,
              textAlign: 'left', padding: '13px 6px 13px 15px', background: 'none',
              border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14.5, fontWeight: 600, color: BRAND.ink }}>
                  {b.title || 'Untitled brief'}
                </span>
                {b.locked && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px',
                    borderRadius: 999, background: '#F0FDF4', border: '1px solid #BBF7D0',
                    fontSize: 10.5, fontWeight: 700, color: '#15803D', textTransform: 'uppercase',
                  }}><Lock size={10} /> Final</span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: '#6B7785', marginTop: 3 }}>
                {b.dealTitle
                  ? <><Briefcase size={11} style={{ verticalAlign: -1 }} /> {b.dealTitle}</>
                  : 'New enquiry'}
                {' · '}
                {b.locked
                  ? `sent ${relTime(b.submittedAt)}`
                  : `${b.done} of ${b.total} answered`}
                {b.contributors > 1 && <> · <Users size={11} style={{ verticalAlign: -1 }} /> {b.contributors} people</>}
              </div>
            </div>
            {!b.locked && (
              <div style={{ width: 46, height: 5, background: '#E8EEF3', borderRadius: 999, overflow: 'hidden', flexShrink: 0 }}>
                <div style={{ width: `${b.pct}%`, height: '100%', background: BRAND.blue }} />
              </div>
            )}
            <ArrowRight size={15} style={{ color: '#9AA5B1', flexShrink: 0 }} />
          </button>

          {/* Staff-only. Chiefly for the empty drafts left behind when briefs
              stopped being per-person — the client shouldn't have to look at
              our mess, and they can't be trusted to tell which of their own
              briefs is the abandoned one. */}
          {manageMode && (
            <button
              type="button" disabled={busy} onClick={() => onDelete(b)}
              title="Delete this brief (staff only)"
              aria-label={`Delete ${b.title || 'untitled brief'}`}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, flexShrink: 0, borderRadius: 8,
                background: 'none', border: '1px solid transparent', cursor: 'pointer',
                color: '#C2410C',
              }}
            ><Trash2 size={15} /></button>
          )}
        </div>
      ))}

      {!canCreate ? null : !picking ? (
        <button
          type="button" onClick={() => setPicking(true)} disabled={busy}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 6,
            background: '#fff', border: '1px dashed #C4D2DC', borderRadius: 9,
            padding: '11px 16px', cursor: 'pointer', color: '#5A7382',
            fontSize: 13.5, fontFamily: 'inherit',
          }}
        ><Plus size={15} /> Start another brief</button>
      ) : (
        <Card style={{ marginTop: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>
            What's this brief for?
          </div>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: '#6B7785', lineHeight: 1.55 }}>
            Telling us which project it belongs to means it goes straight to the team
            working on it, instead of arriving as a new enquiry.
          </p>
          {projects.map((p) => (
            <button
              key={p.id} type="button" disabled={busy || usedDeals.has(p.id)}
              onClick={() => onCreate({ dealId: p.id, title: p.title })}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                padding: '11px 13px', marginBottom: 7, borderRadius: 9, fontFamily: 'inherit',
                border: '1px solid #E8EEF3', background: usedDeals.has(p.id) ? '#F7F9FB' : '#fff',
                cursor: usedDeals.has(p.id) ? 'default' : 'pointer',
                opacity: usedDeals.has(p.id) ? 0.6 : 1,
              }}
            >
              <Briefcase size={15} style={{ color: BRAND.blue, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: BRAND.ink }}>
                {p.title}
                {p.reference && <span style={{ color: '#9AA5B1' }}> · {p.reference}</span>}
              </span>
              {usedDeals.has(p.id) && (
                <span style={{ fontSize: 11.5, color: '#9AA5B1' }}>already has one</span>
              )}
            </button>
          ))}
          <button
            type="button" disabled={busy || hasLoose} onClick={() => onCreate({ dealId: null })}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
              padding: '11px 13px', borderRadius: 9, fontFamily: 'inherit',
              border: '1px dashed #C4D2DC', background: '#fff',
              cursor: hasLoose ? 'default' : 'pointer', opacity: hasLoose ? 0.6 : 1,
            }}
          >
            <Plus size={15} style={{ color: '#5A7382', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 13.5, color: BRAND.ink }}>
              A new project we haven't discussed yet
            </span>
            {hasLoose && <span style={{ fontSize: 11.5, color: '#9AA5B1' }}>already open</span>}
          </button>
          <button
            type="button" onClick={() => setPicking(false)}
            style={{
              background: 'none', border: 'none', padding: '12px 0 0', cursor: 'pointer',
              color: '#6B7785', fontSize: 13, fontFamily: 'inherit',
            }}
          >Cancel</button>
        </Card>
      )}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function Brief({ briefId: routeId = null }) {
  const { manageMode, showToast } = usePortal();
  const [index, setIndex] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadIndex = useCallback(async () => {
    try { setIndex(await portalApi.get('brief')); setError(null); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { loadIndex(); }, [loadIndex]);

  const create = async ({ dealId, title }) => {
    setBusy(true);
    try {
      const r = await portalApi.post('brief-create', { dealId, title });
      await loadIndex();
      navigate(`#/brief/${r.id}`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  // Two-step on purpose. An empty draft is a click to clear; one with answers
  // in it takes a second, differently-worded confirmation that says how much is
  // about to go, because nothing else in the system holds a copy of it.
  const remove = async (brief) => {
    const name = brief.title || 'this untitled brief';
    if (!window.confirm(`Delete ${name}? This can't be undone.`)) return;
    setBusy(true);
    try {
      await portalApi.post('brief-delete', { id: brief.id });
      showToast('Brief deleted');
      await loadIndex();
      if (routeId === brief.id) navigate('#/brief');
    } catch (err) {
      if (err.status === 409) {
        const ok = window.confirm(
          `${name} has ${brief.done} of ${brief.total} questions answered.\n\n`
          + 'Deleting it destroys those answers and the record of who wrote them. '
          + 'Nothing else keeps a copy.\n\nDelete it anyway?'
        );
        if (!ok) { setBusy(false); return; }
        try {
          await portalApi.post('brief-delete', { id: brief.id, force: true });
          showToast('Brief deleted');
          await loadIndex();
          if (routeId === brief.id) navigate('#/brief');
        } catch (e2) { showToast(e2.message); }
      } else {
        showToast(err.message);
      }
    } finally { setBusy(false); }
  };

  if (error) return <EmptyState title="Couldn't open your brief" body={error} />;
  if (!index) return <div style={{ padding: 32, color: '#6B7785' }}>Loading…</div>;

  // A brief named in the URL opens straight into it. So does the only one a
  // CLIENT has — the lead-magnet email points at #/brief, and landing a
  // first-time visitor on a one-item list instead of the questions loses them.
  // Staff always get the list first: it's where the delete lives, and skipping
  // it would hide the only way to clear an abandoned draft.
  const autoOpen = !index.readOnly && index.briefs?.length === 1;
  const openId = routeId || (autoOpen ? index.activeId : null);
  if (openId) {
    return (
      <BriefEditor
        key={openId}
        briefId={openId}
        projects={index.projects || []}
        showBack={!!routeId || (index.briefs || []).length > 1}
        onChanged={loadIndex}
      />
    );
  }
  if (!index.briefs?.length) {
    return (
      <EmptyState
        icon={<FileText size={22} />}
        title="No brief yet"
        body="This organisation hasn't started a video brief. Once someone does, their answers appear here as they type."
      />
    );
  }
  return (
    <BriefList
      data={index}
      busy={busy}
      manageMode={manageMode}
      onOpen={(id) => navigate(`#/brief/${id}`)}
      onCreate={create}
      onDelete={remove}
    />
  );
}

function BriefEditor({ briefId, projects, showBack, onChanged }) {
  const { showToast, manageMode, user } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [answers, setAnswers] = useState({});
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [sending, setSending] = useState(false);
  const [showInvalid, setShowInvalid] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [presence, setPresence] = useState([]);
  const [activity, setActivity] = useState([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [linking, setLinking] = useState(false);

  const [dirty, setDirty] = useState(false);
  const pending = useRef({});
  const timer = useRef(null);
  // Which question this tab is in, reported on each tick so colleagues see it.
  const editingKey = useRef(null);
  const lastEventId = useRef(null);

  const locked = !!data?.brief?.locked;
  const readOnly = !!data?.readOnly;
  const canEdit = !locked && !readOnly;
  // Saying which job a brief is for is FILING, not answering, and it is the
  // one thing about a brief staff may change — see briefAttachRoute. For the
  // client it follows the lock; for staff in manage mode it never does,
  // because a brief filed under the wrong project is precisely what you
  // discover after it has been finalised.
  const canFile = readOnly ? manageMode : !locked;

  useEffect(() => {
    (async () => {
      try {
        const d = await portalApi.get(`brief?id=${encodeURIComponent(briefId)}`);
        setData(d);
        setActivity(d.activity || []);
        setPresence(d.presence || []);
        lastEventId.current = d.activity?.[0]?.id || null;
        const fromServer = d.brief?.answers || {};

        // Previewing staff have no draft of their own to recover, and must not
        // push one into the client's brief. Nor does a finalised brief.
        if (d.readOnly || d.brief?.locked) { setAnswers(fromServer); return; }

        // Recover anything that was typed but hadn't reached the server — a
        // save in flight when the tab closed, or edits made while offline.
        const mirror = readMirror(briefId);
        const serverAt = d.brief?.updatedAt ? new Date(d.brief.updatedAt).getTime() : 0;
        if (mirror && mirror.at > serverAt + 1000) {
          setAnswers({ ...fromServer, ...mirror.answers });
          // Push it back up straight away rather than waiting for them to type.
          portalApi.patch('brief', { id: briefId, answers: mirror.answers })
            .then(() => setSavedAt(new Date()))
            .catch(() => {});
        } else {
          setAnswers(fromServer);
        }
      } catch (err) { setError(err.message); }
    })();
  }, [briefId]);

  // Where to offer to pick up, decided ONCE per brief on open.
  //
  // Deliberately not derived from `answers` on every render: it would move as
  // they type, and a banner offering to send you somewhere that keeps changing
  // is a banner nobody trusts. Null means don't offer — either they have not
  // started, or the first gap is the screen they are already on.
  const resumeDecided = useRef(false);
  useEffect(() => {
    if (resumeDecided.current || !data || data.readOnly || data.brief?.locked) return;
    resumeDecided.current = true;
    const loaded = data.brief?.answers || {};
    if (!Object.keys(loaded).some((k) => !isBlank(loaded[k]))) return;
    const gap = SCREENS.findIndex((s) => s.questions.some((q) => !q.optional && isBlank(loaded[q.key])));
    if (gap > 0) setResumeOffer(gap);
  }, [data]);

  // Debounced autosave. Only the changed keys go up, so two people editing
  // different questions merge rather than clobber (the server does `||`).
  const flush = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    setSaving(true);
    try {
      await portalApi.patch('brief', { id: briefId, answers: patch });
      setSavedAt(new Date());
      setDirty(false);
    } catch (err) {
      // A finalised brief is the one failure worth interrupting for: the
      // answers in front of them are no longer going anywhere, and quietly
      // retrying would let them keep typing into a document that's closed.
      if (err.status === 409) {
        setData((d) => (d ? { ...d, brief: { ...d.brief, locked: true } } : d));
        showToast('This brief has been finalised — it can no longer be changed.', 'error');
        return;
      }
      // Otherwise deliberately quiet. The value is still in state AND in the
      // local mirror, and will go up with the next edit or the next page load;
      // a red banner over a half-typed sentence helps nobody. `dirty` stays
      // true so the status line honestly says "not saved yet" rather than lying.
      Object.assign(pending.current, patch);
    } finally { setSaving(false); }
  }, [briefId, showToast]);

  const setAnswer = useCallback((key, value) => {
    setAnswers((a) => {
      const next = { ...a, [key]: value };
      // Layer 1: synchronous, every keystroke, cannot fail.
      writeMirror(briefId, next);
      return next;
    });
    pending.current[key] = value;
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush, briefId]);

  // ── the collaboration tick ────────────────────────────────────────────────
  // One request that says "I'm here, on this question" and gets back who else
  // is, plus anything they've changed. Paused when the tab is hidden: a brief
  // left open in a background tab shouldn't hold a presence slot or poll all
  // afternoon.
  useEffect(() => {
    if (!briefId || locked) return undefined;
    let stopped = false;

    const tick = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const r = await portalApi.post('brief-tick', {
          id: briefId,
          editingKey: editingKey.current,
          sinceEventId: lastEventId.current,
        });
        if (stopped) return;
        setPresence(r.presence || []);
        if (r.events?.length) {
          setActivity((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            return [...r.events.filter((e) => !seen.has(e.id)), ...prev];
          });
          lastEventId.current = r.events[0].id;
        }
        if (r.locked) {
          setData((d) => (d ? { ...d, brief: { ...d.brief, locked: true } } : d));
          return;
        }
        // Take colleagues' answers, but NEVER for a question this person has
        // unsaved edits in or is sitting in right now — the whole value of the
        // feature evaporates the first time it deletes a sentence mid-word.
        setAnswers((mine) => {
          const next = { ...mine };
          let changed = false;
          for (const [k, v] of Object.entries(r.answers || {})) {
            if (k === editingKey.current) continue;
            if (Object.prototype.hasOwnProperty.call(pending.current, k)) continue;
            if (JSON.stringify(mine[k] ?? null) === JSON.stringify(v ?? null)) continue;
            next[k] = v;
            changed = true;
          }
          return changed ? next : mine;
        });
      } catch { /* a missed tick costs one cycle of presence; keep going */ }
    };

    const id = setInterval(tick, TICK_MS);
    tick();
    return () => { stopped = true; clearInterval(id); };
  }, [briefId, locked]);

  // Don't lose the last few keystrokes to a tab close or a nav away. `pagehide`
  // is the one that actually fires on iOS Safari, where `beforeunload` doesn't.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    const warn = (e) => {
      if (!Object.keys(pending.current).length) return;
      e.preventDefault();
      e.returnValue = '';
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', warn);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', warn);
      clearTimeout(timer.current);
      flush();
    };
  }, [flush]);

  // Which screen the welcome-back banner offers, or null for no banner.
  const [resumeOffer, setResumeOffer] = useState(null);

  // Which guide video is open over the brief, by module number, or null.
  const [watching, setWatching] = useState(null);

  const progress = useMemo(() => briefProgress(answers), [answers]);
  const missing = useMemo(() => missingRequired(answers), [answers]);
  const editorsByKey = useMemo(() => {
    const m = new Map();
    for (const p of presence) {
      if (!p.questionKey) continue;
      m.set(p.questionKey, [...(m.get(p.questionKey) || []), p]);
    }
    return m;
  }, [presence]);

  const screens = SCREENS;
  const isReview = step >= screens.length;
  const screen = screens[step] || null;

  // Review is a step of the stepper, not a thing that happens after it. It is
  // the last circle for the same reason the quote form's is "Finish": people
  // pace themselves against the number of circles left, and a review stage that
  // appears out of nowhere at the end reads as one more form to fill in.
  const stepperSteps = useMemo(
    () => [
      ...screens.map((s) => ({ key: s.key, label: s.short || s.title, title: s.title })),
      { key: '__review', label: 'Review', title: 'Review and finalise' },
    ],
    [screens],
  );

  // A dot on any screen a colleague is typing in, so you can go somewhere
  // useful instead of finding out on arrival.
  const busyScreens = useMemo(() => {
    const out = {};
    for (const s of screens) {
      if (s.questions.some((q) => editorsByKey.has(q.key))) out[s.key] = true;
    }
    return out;
  }, [screens, editorsByKey]);

  const minutesLeft = useMemo(() => {
    if (isReview) return 0;
    return Math.ceil(screens.slice(step).reduce((t, s) => t + (s.minutes || 0), 0));
  }, [screens, step, isReview]);

  // First name only, and only where it reads as a person talking. The quote
  // form does the same: a greeting on the first screen, then the name on the
  // ones after it, because by then it has been earned rather than assumed.
  const firstName = useMemo(() => {
    const n = String(user?.name || '').trim();
    return n ? n.split(/\s+/)[0] : null;
  }, [user]);

  const screenTitle = useMemo(() => {
    if (!screen) return '';
    if (step === 0) return `${greeting()} ${screen.title}`;
    if (!firstName) return screen.title;
    // Only the two mid-form screens get the name. Every screen would be a
    // mail-merge, and by the last one it stops reading as friendly.
    if (step === 2) return `Thanks ${firstName} — ${screen.title.toLowerCase()}`;
    if (step === screens.length - 1) return `Almost done, ${firstName}`;
    return screen.title;
  }, [screen, step, firstName, screens.length]);

  const attach = async (dealId) => {
    setLinking(true);
    try {
      await portalApi.post('brief-attach', { id: briefId, dealId });
      const d = await portalApi.get(`brief?id=${encodeURIComponent(briefId)}`);
      setData(d);
      setActivity(d.activity || []);
      onChanged?.();
      // Names the project rather than saying "your" — staff file these too,
      // and a toast that calls it their project reads wrong from manage mode.
      const filed = projects.find((x) => x.id === dealId);
      showToast(dealId ? `Filed to ${filed?.title || 'the project'}` : 'Set as a new enquiry', 'success');
    } catch (err) { showToast(err.message, 'error'); } finally { setLinking(false); }
  };

  const finalise = async () => {
    await flush();
    if (missing.length) {
      setShowInvalid(true);
      const first = screens.findIndex((s) => s.key === missing[0].screenKey);
      setStep(first >= 0 ? first : 0);
      showToast(`${missing.length} question${missing.length === 1 ? '' : 's'} still needs an answer`, 'error');
      return;
    }
    setSending(true);
    try {
      await portalApi.post('brief', { id: briefId });
      showToast('Brief finalised — we\'ll come back to you shortly', 'success');
      // The mirror belonged to a brief that's now locked; leaving it would let
      // a stale local copy try to push itself back into a closed document.
      clearMirror(briefId);
      const d = await portalApi.get(`brief?id=${encodeURIComponent(briefId)}`);
      setData(d);
      setActivity(d.activity || []);
      setAnswers(d.brief?.answers || {});
      onChanged?.();
      setStep(0);
    } catch (err) {
      showToast(err.message || "Couldn't finalise the brief", 'error');
    } finally { setSending(false); }
  };

  const reopen = async () => {
    try {
      await portalApi.post('brief-reopen', { id: briefId });
      const d = await portalApi.get(`brief?id=${encodeURIComponent(briefId)}`);
      setData(d);
      setActivity(d.activity || []);
      onChanged?.();
      showToast('Brief reopened for editing', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  };

  if (error) return <EmptyState title="Couldn't open your brief" body={error} />;
  if (!data) return <div style={{ padding: 32, color: '#6B7785' }}>Loading…</div>;

  const brief = data.brief || {};
  // Everyone live on this brief right now, whichever question they are in.
  const others = presence;

  const header = (
    <div className="brief-noprint" style={{ marginBottom: 18 }}>
      {showBack && (
        <button
          type="button" onClick={() => navigate('#/brief')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none',
            border: 'none', padding: '0 0 8px', cursor: 'pointer', color: BRAND.blue,
            fontSize: 13, fontFamily: 'inherit',
          }}
        ><ArrowLeft size={14} /> All briefs</button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <FileText size={20} style={{ color: BRAND.blue }} />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: BRAND.ink }}>
          {readOnly ? 'Their video brief' : (brief.title || 'Your video brief')}
        </h1>
        {locked && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
            borderRadius: 999, background: '#F0FDF4', border: '1px solid #BBF7D0',
            fontSize: 11.5, fontWeight: 700, color: '#15803D',
          }}><Lock size={12} /> Finalised</span>
        )}
      </div>

      {/* Which job this is for, and a way to say so if nobody has. A brief that
          doesn't name its project arrives as a fresh enquiry, which for work
          already signed means someone has to work out where it belongs. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {brief.dealTitle ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 11px',
            borderRadius: 999, background: '#EAF7FD', border: '1px solid #BFE0EE',
            fontSize: 12.5, fontWeight: 600, color: '#0B6E93',
          }}>
            <Briefcase size={12} /> {brief.dealTitle}
            {brief.dealReference && <span style={{ opacity: 0.7 }}>· {brief.dealReference}</span>}
          </span>
        ) : (
          <span style={{ fontSize: 12.5, color: '#6B7785' }}>New enquiry</span>
        )}
        {canFile && projects.length > 0 && (
          <select
            value={brief.dealId || ''}
            disabled={linking}
            onChange={(e) => attach(e.target.value || null)}
            style={{
              fontSize: 12.5, fontFamily: 'inherit', color: '#5A7382', padding: '4px 8px',
              border: '1px solid #D8E0E8', borderRadius: 8, background: '#fff', cursor: 'pointer',
            }}
          >
            <option value="">Not linked to a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title}{p.reference ? ` · ${p.reference}` : ''}</option>
            ))}
          </select>
        )}
        {!brief.dealId && canFile && projects.length > 0 && (
          <span style={{ fontSize: 11.5, color: '#9AA5B1', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Link2 size={11} />
            {readOnly ? 'not filed to a project yet' : 'link it so it reaches the right team'}
          </span>
        )}
      </div>

      {/* Who's here. Names, not a count: on a document three people share, the
          useful fact is which three. */}
      {others.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 10,
          fontSize: 12.5, color: '#5A7382',
        }}>
          <span style={{ display: 'flex' }}>
            {others.map((p) => (
              <span key={p.portalUserId} style={{ marginRight: -6 }}>
                <Avatar name={p.name} size={22} />
              </span>
            ))}
          </span>
          <span style={{ marginLeft: 8 }}>
            {others.length === 1
              ? `${others[0].name} is here too`
              : `${others.length} colleagues are here too`}
          </span>
        </div>
      )}
    </div>
  );

  // ── finalised: the document, and nothing that pretends to change it ───────
  if (locked) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {header}
        <Card>
          <div style={{
            display: 'flex', gap: 10, padding: '11px 13px', marginBottom: 18,
            background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 9,
            fontSize: 13, color: '#15803D', lineHeight: 1.5,
          }}>
            <Lock size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong>This brief is final.</strong>{' '}
              {brief.submittedBy ? `${brief.submittedBy} finalised it` : 'It was finalised'}
              {brief.submittedAt ? ` ${relTime(brief.submittedAt)}` : ''} and it can't be changed —
              our team is working from this exact version. If something needs to move, just tell us
              and we'll reopen it.
            </div>
          </div>
          <BriefSummary answers={answers} />
          <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => window.print()} style={btnGhost}>
              <Printer size={15} /> Print or save as PDF
            </button>
            {data.canReopen && (
              <button type="button" onClick={reopen} style={btnGhost}>
                Reopen for editing
              </button>
            )}
          </div>
        </Card>
        <ActivityFeed events={activity} open={activityOpen} onToggle={() => setActivityOpen((v) => !v)} />
        <div className="brief-print">
          <h1 style={{ fontSize: 20, marginBottom: 4 }}>{brief.title || 'Video brief'}</h1>
          <p style={{ fontSize: 12, color: '#666', marginTop: 0 }}>Video brief · Squideo</p>
          <BriefSummary answers={answers} print />
        </div>
      </div>
    );
  }

  // Staff previewing a client's portal. Read-only by design — see briefRoute —
  // so render what they filled in rather than an editable form whose every
  // keystroke would 403.
  if (readOnly) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {header}
        <p style={{ margin: '0 0 16px', fontSize: 13.5, lineHeight: 1.6, color: '#6B7785' }}>
          {progress.done} of {progress.total} answered · still a draft, so this may still change.
          You're previewing, so this is read-only.
        </p>
        <Card><BriefSummary answers={answers} /></Card>
        <ActivityFeed events={activity} open={activityOpen} onToggle={() => setActivityOpen((v) => !v)} />
      </div>
    );
  }

  // Reassurance, not telemetry. Someone deciding whether they can close the tab
  // and finish this tomorrow needs to be told they can, in words — a timestamp
  // alone doesn't answer the question they're actually asking.
  const save = saving
    ? { text: 'Saving…', kind: 'busy' }
    : dirty
      ? { text: 'Unsaved changes — keep typing, we\'ll save them', kind: 'warn' }
      : savedAt
        ? {
            text: `Saved at ${savedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Close the tab whenever — your team can see it too.`,
            kind: 'good',
          }
        : { text: 'Saves automatically as you type. Stop halfway and come back whenever.', kind: 'good' };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <style>{`
        @media print {
          .brief-noprint { display: none !important; }
          .brief-print   { display: block !important; }
        }
        .brief-print { display: none; }
      `}</style>

      {header}

      <div className="brief-noprint">
        {/* Only for someone coming back to work already in progress. On a brief
            they have just started there is nothing to resume and the banner is
            a bright green box announcing that they have done nothing. */}
        {resumeOffer !== null && (
          <ResumeBanner
            name={firstName}
            done={progress.done}
            total={progress.total}
            onResume={() => { setStep(resumeOffer); setResumeOffer(null); }}
            onDismiss={() => setResumeOffer(null)}
          />
        )}

        <StepProgress
          steps={stepperSteps}
          current={step}
          onJump={setStep}
          markers={busyScreens}
        />
      </div>

      {/* ── the current screen ──────────────────────────────────────────── */}
      {!isReview && screen && (
        <Card>
          <TimeBadge minutes={minutesLeft} />

          <StepTitle title={screenTitle}>
            {screen.blurb}
            {screen.optional && (
              <span style={{ display: 'block', marginTop: 6, fontSize: 13.5, color: '#9AA5B1' }}>
                Optional — most people skip this.
              </span>
            )}
          </StepTitle>

          {/* The quote form puts a privacy line here because "who sees my phone
              number" is the worry that stops people finishing it. Twenty-five
              questions raises a different one — what happens if I stop — so
              this answers that instead, in the same place, in the same shape.
              It doubles as the save indicator, which is the honest way to make
              the promise: it says "saved at 14:32", not just "we save". */}
          <ReassuranceBadge tone={save.kind}>{save.text}</ReassuranceBadge>

          {screen.optional && !scriptOpen ? (
            <button
              type="button" onClick={() => setScriptOpen(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                background: '#fff', border: '1px dashed #C4D2DC', borderRadius: 9,
                padding: '11px 16px', cursor: 'pointer', color: '#5A7382',
                fontSize: 13.5, fontFamily: 'inherit',
              }}
            ><ChevronDown size={15} /> I've got some wording in mind</button>
          ) : (
            screen.questions.map((q) => (
              <Question
                key={q.key} q={q} answers={answers} onWatch={setWatching}
                value={answers[q.key]}
                editors={editorsByKey.get(q.key) || []}
                onChange={(v) => setAnswer(q.key, v)}
                onFocus={() => { editingKey.current = q.key; }}
                onBlur={() => { if (editingKey.current === q.key) editingKey.current = null; flush(); }}
                invalid={showInvalid && q.required && isBlank(answers[q.key])}
              />
            ))
          )}

          <div style={{
            display: 'flex', gap: 10, marginTop: 8, paddingTop: 18,
            borderTop: '1px solid #EEF2F5', flexWrap: 'wrap',
          }}>
            {step > 0 && (
              <button type="button" onClick={() => setStep(step - 1)} style={btnGhost}>
                <ArrowLeft size={15} /> Back
              </button>
            )}
            <button type="button" onClick={() => { flush(); setStep(step + 1); }} style={btnPrimary}>
              {step === screens.length - 1 ? 'Review' : 'Next'} <ArrowRight size={15} />
            </button>
          </div>
        </Card>
      )}

      {/* ── review + finalise ───────────────────────────────────────────── */}
      {isReview && (
        <Card>
          <StepTitle title={firstName ? `Ready when you are, ${firstName}` : 'Ready to finalise'}>
            Have a read through — and check whoever else needs to has had their say, because
            <strong> finalising locks it</strong>. Our team works from this exact version, so it
            can't move underneath them afterwards. We can always reopen it for you if it needs to.
          </StepTitle>
          <BriefSummary answers={answers} onEdit={(k) => {
            const i = screens.findIndex((s) => s.questions.some((q) => q.key === k));
            if (i >= 0) setStep(i);
          }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setStep(screens.length - 1)} style={btnGhost}>
              <ArrowLeft size={15} /> Back
            </button>
            <button type="button" onClick={() => window.print()} style={btnGhost}>
              <Printer size={15} /> Print or save as PDF
            </button>
            <button type="button" onClick={finalise} disabled={sending} style={{
              ...btnPrimary, background: sending ? '#9AC9DE' : '#16A34A',
              cursor: sending ? 'default' : 'pointer',
            }}>
              <Send size={15} /> {sending ? 'Sending…' : 'Finalise and send'}
            </button>
          </div>
          {missing.length > 0 && (
            <p style={{ margin: '12px 0 0', fontSize: 13, color: '#B45309' }}>
              {missing.length} question{missing.length === 1 ? '' : 's'} still to answer:{' '}
              {missing.map((m) => m.label).join(' · ')}
            </p>
          )}
        </Card>
      )}

      <ActivityFeed events={activity} open={activityOpen} onToggle={() => setActivityOpen((v) => !v)} />

      {/* Over the brief, never instead of it: the page stays mounted, so closing
          the video puts them back on the exact question that prompted it. */}
      {watching !== null && (
        <GuideVideoModal moduleNumber={watching} onClose={() => setWatching(null)} />
      )}

      {/* Print-only: the whole brief on one page, no chrome. */}
      <div className="brief-print">
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>
          {brief.title || answers.projectName || 'Video brief'}
        </h1>
        <p style={{ fontSize: 12, color: '#666', marginTop: 0 }}>Video brief · Squideo</p>
        <BriefSummary answers={answers} print />
      </div>
    </div>
  );
}

function BriefSummary({ answers, onEdit = null, print = false }) {
  return (
    <div>
      {SCREENS.map((s) => {
        const rows = s.questions.filter((q) => !isBlank(answers[q.key]));
        if (!rows.length) return null;
        return (
          <div key={s.key} style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 11.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
              color: '#9AA5B1', marginBottom: 8,
            }}>{s.title}</div>
            {rows.map((q) => (
              <div key={q.key} style={{ marginBottom: 11 }}>
                <div style={{ fontSize: 12.5, color: '#6B7785', marginBottom: 2 }}>
                  {q.label}
                  {onEdit && (
                    <button
                      type="button" onClick={() => onEdit(q.key)}
                      style={{
                        marginLeft: 8, background: 'none', border: 'none', padding: 0,
                        cursor: 'pointer', color: BRAND.blue, fontSize: 12, fontFamily: 'inherit',
                      }}
                    >edit</button>
                  )}
                </div>
                <div style={{
                  fontSize: 14, color: BRAND.ink, lineHeight: 1.55, whiteSpace: 'pre-wrap',
                }}>{displayValue(q, answers[q.key])}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function displayValue(q, v) {
  if (q.type === 'scriptTable') {
    return (Array.isArray(v) ? v : [])
      .filter((r) => r && (String(r.script || '').trim() || String(r.visual || '').trim()))
      .map((r, i) => `${i + 1}. ${r.script || '—'}\n   [visual] ${r.visual || '—'}`)
      .join('\n');
  }
  if (q.options) {
    const find = (x) => q.options.find((o) => o.value === x)?.label || x;
    return Array.isArray(v) ? v.map(find).join(', ') : find(v);
  }
  return v;
}

const btnBase = {
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '11px 18px',
  borderRadius: 9, fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
  cursor: 'pointer', border: '1px solid transparent',
};
const btnPrimary = { ...btnBase, background: BRAND.blue, color: '#fff' };
const btnGhost = { ...btnBase, background: '#fff', color: '#5A7382', borderColor: '#D8E0E8' };
