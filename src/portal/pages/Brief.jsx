// The video brief, as a page you can come back to.
//
// This replaces "download our Word template". A template is a document someone
// fills in alone with no prompts, and most never come back — we never even
// learn they tried. This autosaves every field, so an abandoned brief is still
// a visible, warm lead, and a finished one arrives as a real document.
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
  Info, GraduationCap, ChevronDown,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useIsMobile } from '../../utils.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState } from '../components.jsx';
import { navigate } from '../PortalApp.jsx';
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
const MIRROR_KEY = 'sq_brief_draft';

const readMirror = (briefId) => {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    return m && m.briefId === briefId ? m : null;
  } catch { return null; }
};
const writeMirror = (briefId, answers) => {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ briefId, answers, at: Date.now() }));
  } catch { /* private mode / quota — the server save is still the real one */ }
};
const clearMirror = () => { try { localStorage.removeItem(MIRROR_KEY); } catch { /* ignore */ } };

// Must agree with isEmpty() in api/_lib/brief/questions.js — if the client
// thinks a question is answered and the server doesn't, "Send" bounces with no
// visible reason.
const isBlank = (v) =>
  v == null ||
  (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && (v.length === 0 || v.every((r) => !r || (typeof r === 'object'
    ? !String(r.script || '').trim() && !String(r.visual || '').trim()
    : !String(r).trim()))));

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

function WhyWeAsk({ text, videoRef }) {
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
              onClick={() => navigate('#/course')}
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

function Chips({ options, value, onChange, multi = false }) {
  const selected = multi ? (Array.isArray(value) ? value : []) : value;
  const isOn = (v) => (multi ? selected.includes(v) : selected === v);
  const toggle = (v) => {
    if (!multi) return onChange(selected === v ? null : v);
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => toggle(o.value)}
          style={{
            padding: '9px 14px', borderRadius: 999, cursor: 'pointer',
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
function ScriptTable({ value, onChange }) {
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
            value={r.script || ''} rows={3}
            onChange={(e) => set(i, 'script', e.target.value)}
            placeholder={isMobile || i === 0 ? 'What is said…' : ''}
            style={{ ...inp, flex: '1 1 240px', resize: 'vertical' }}
          />
          <textarea
            value={r.visual || ''} rows={3}
            onChange={(e) => set(i, 'visual', e.target.value)}
            placeholder={isMobile || i === 0 ? 'What is on screen…' : ''}
            style={{ ...inp, flex: '1 1 240px', resize: 'vertical' }}
          />
          {rows.length > 1 && (
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
    </div>
  );
}

function Question({ q, value, onChange, onBlur, answers, invalid }) {
  const isMobile = useIsMobile();
  const inp = inputStyle(isMobile);
  const suggestion = q.suggestFrom ? suggestedLength(answers) : null;
  return (
    <div style={{ marginBottom: 26 }}>
      <label style={{
        display: 'block', fontSize: 14.5, fontWeight: 600, color: BRAND.ink,
        marginBottom: q.type === 'chips' || q.type === 'multi' ? 10 : 7, lineHeight: 1.4,
      }}>
        {q.label}
        {q.required && <span style={{ color: '#D14343', marginLeft: 4 }}>*</span>}
      </label>

      {/* onBlur saves immediately rather than waiting out the debounce — moving
          to the next question is the clearest signal that an answer is done. */}
      {q.type === 'text' && (
        <input
          type="text" value={value || ''} placeholder={q.placeholder || ''}
          onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
          style={{ ...inp, borderColor: invalid ? '#E9A0A0' : '#D8E0E8' }}
        />
      )}
      {q.type === 'textarea' && (
        <textarea
          value={value || ''} rows={q.rows || 3} placeholder={q.placeholder || ''}
          onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
          style={{ ...inp, resize: 'vertical', borderColor: invalid ? '#E9A0A0' : '#D8E0E8' }}
        />
      )}
      {(q.type === 'chips' || q.type === 'multi') && (
        <Chips options={q.options} value={value} onChange={onChange} multi={q.type === 'multi'} />
      )}
      {q.type === 'scriptTable' && <ScriptTable value={value} onChange={onChange} />}

      {suggestion && isBlank(value) && (
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

      <WhyWeAsk text={q.why} videoRef={q.videoRef} />
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function Brief() {
  const { showToast } = usePortal();
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [answers, setAnswers] = useState({});
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [sending, setSending] = useState(false);
  const [showInvalid, setShowInvalid] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);

  const [dirty, setDirty] = useState(false);
  const pending = useRef({});
  const timer = useRef(null);
  const briefId = useRef(null);
  const stepsRef = useRef(null);

  // With the screen pills on one scrollable row, moving on with Next would
  // otherwise leave the highlighted pill off-screen — so the one cue telling
  // you how far through you are disappears exactly when you use it.
  useEffect(() => {
    if (!isMobile || !stepsRef.current) return;
    const el = stepsRef.current.children[step];
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [step, isMobile]);

  useEffect(() => {
    (async () => {
      try {
        const d = await portalApi.get('brief');
        setData(d);
        briefId.current = d.brief?.id || null;
        const fromServer = d.brief?.answers || {};

        // Previewing staff have no draft of their own to recover, and must not
        // push one into the client's brief.
        if (d.readOnly) { setAnswers(fromServer); return; }

        // Recover anything that was typed but hadn't reached the server — a
        // save in flight when the tab closed, or edits made while offline.
        const mirror = readMirror(d.brief?.id);
        const serverAt = d.brief?.updatedAt ? new Date(d.brief.updatedAt).getTime() : 0;
        if (mirror && mirror.at > serverAt + 1000) {
          const merged = { ...fromServer, ...mirror.answers };
          setAnswers(merged);
          // Push it back up straight away rather than waiting for them to type.
          portalApi.patch('brief', { answers: mirror.answers })
            .then(() => setSavedAt(new Date()))
            .catch(() => {});
        } else {
          setAnswers(fromServer);
        }
      } catch (err) { setError(err.message); }
    })();
  }, []);

  // Debounced autosave. Only the changed keys go up, so two devices editing
  // different questions merge rather than clobber (the server does `||`).
  const flush = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    setSaving(true);
    try {
      await portalApi.patch('brief', { answers: patch });
      setSavedAt(new Date());
      setDirty(false);
    } catch {
      // Deliberately quiet. The value is still in state AND in the local
      // mirror, and will go up with the next edit or the next page load; a red
      // banner over a half-typed sentence helps nobody. `dirty` stays true so
      // the status line honestly says "not saved yet" rather than lying.
      Object.assign(pending.current, patch);
    } finally { setSaving(false); }
  }, []);

  const setAnswer = useCallback((key, value) => {
    setAnswers((a) => {
      const next = { ...a, [key]: value };
      // Layer 1: synchronous, every keystroke, cannot fail.
      writeMirror(briefId.current, next);
      return next;
    });
    pending.current[key] = value;
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush]);

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

  const progress = useMemo(() => briefProgress(answers), [answers]);
  const missing = useMemo(() => missingRequired(answers), [answers]);
  const screens = SCREENS;
  const isReview = step >= screens.length;
  const screen = screens[step] || null;

  const submit = async () => {
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
      await portalApi.post('brief');
      showToast('Brief sent — we\'ll come back to you shortly', 'success');
      // The mirror belonged to the brief that's now been sent; leaving it would
      // resurrect those answers into the next blank one.
      clearMirror();
      const d = await portalApi.get('brief');
      setData(d);
      briefId.current = d.brief?.id || null;
      setAnswers(d.brief?.answers || {});
      setSavedAt(null);
      setDirty(false);
      setStep(0);
    } catch (err) {
      showToast(err.message || "Couldn't send the brief", 'error');
    } finally { setSending(false); }
  };

  if (error) return <EmptyState title="Couldn't open your brief" body={error} />;
  if (!data) return <div style={{ padding: 32, color: '#6B7785' }}>Loading…</div>;

  // Staff previewing a client's portal. Read-only by design — see briefRoute —
  // so render what they filled in rather than an editable form whose every
  // keystroke would 403.
  if (data.readOnly) {
    if (!data.brief && !data.past?.length) {
      return (
        <EmptyState
          icon={<FileText size={22} />}
          title="No brief yet"
          body="This client hasn't started a video brief. Once they do, their answers appear here as they type — you don't have to wait for them to send it."
        />
      );
    }
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <FileText size={20} style={{ color: BRAND.blue }} />
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: BRAND.ink }}>Their video brief</h1>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 13.5, lineHeight: 1.6, color: '#6B7785' }}>
          {progress.done} of {progress.total} answered
          {data.brief?.submittedAt ? ' · sent' : ' · still a draft, so this may still change'}.
          You're previewing, so this is read-only.
        </p>
        <Card><BriefSummary answers={answers} /></Card>
      </div>
    );
  }

  // Reassurance, not telemetry. Someone deciding whether they can close the tab
  // and finish this tomorrow needs to be told they can, in words — a timestamp
  // alone doesn't answer the question they're actually asking.
  const save = saving
    ? { text: 'Saving…', tone: '#5A7382', icon: null }
    : dirty
      ? { text: 'Unsaved changes — keep typing, we\'ll save them', tone: '#B45309', icon: null }
      : savedAt
        ? {
            text: `Draft saved at ${savedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} — you can close this and come back`,
            tone: '#15803D', icon: <Check size={13} />,
          }
        : { text: 'Saves automatically as you type', tone: '#9AA5B1', icon: null };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <style>{`
        @media print {
          .brief-noprint { display: none !important; }
          .brief-print   { display: block !important; }
        }
        .brief-print { display: none; }
      `}</style>

      {/* ── header + progress ───────────────────────────────────────────── */}
      <div className="brief-noprint" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <FileText size={20} style={{ color: BRAND.blue }} />
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: BRAND.ink }}>Your video brief</h1>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.6, color: '#6B7785' }}>
          Answer what you can — we can work from as little as a list of key points.
          It saves as you go, so you can leave it and come back.
        </p>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          fontSize: 12.5, color: '#6B7785', marginBottom: 8,
        }}>
          <div style={{ flex: '1 1 180px', height: 6, background: '#E8EEF3', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{
              width: `${progress.pct}%`, height: '100%', background: BRAND.blue,
              borderRadius: 999, transition: 'width .3s ease',
            }} />
          </div>
          <span style={{ whiteSpace: 'nowrap' }}>{progress.done} of {progress.total}</span>
        </div>

        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12,
          fontSize: 12.5, color: save.tone, fontWeight: save.icon ? 600 : 500,
        }}>
          {save.icon}{save.text}
        </div>

        {/* Seven pills wrap to three rows at phone width, pushing the actual
            question below the fold before anyone has answered anything. One
            swipeable row instead — the same trick the CRM boards use. */}
        <div
          ref={stepsRef}
          className={isMobile ? 'hide-scrollbar' : undefined}
          style={isMobile
            ? { display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -16px', padding: '0 16px', scrollSnapType: 'x proximity' }
            : { display: 'flex', flexWrap: 'wrap', gap: 6 }}
        >
          {screens.map((s, i) => (
            <button
              key={s.key} type="button" onClick={() => setStep(i)}
              style={{
                padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
                fontSize: 12, fontFamily: 'inherit',
                flexShrink: 0, scrollSnapAlign: 'start',
                fontWeight: i === step ? 700 : 500,
                border: `1px solid ${i === step ? BRAND.blue : '#E0E7ED'}`,
                background: i === step ? '#EAF7FD' : '#fff',
                color: i === step ? BRAND.ink : '#7E8B96',
              }}
            >{s.title}{s.optional ? ' ·' : ''}</button>
          ))}
        </div>
      </div>

      {/* ── the current screen ──────────────────────────────────────────── */}
      {!isReview && screen && (
        <Card>
          <h2 style={{ margin: '0 0 6px', fontSize: 17.5, fontWeight: 700, color: BRAND.ink }}>
            {screen.title}
            {screen.optional && (
              <span style={{ marginLeft: 9, fontSize: 12.5, fontWeight: 500, color: '#9AA5B1' }}>
                optional — most people skip this
              </span>
            )}
          </h2>
          {screen.blurb && (
            <p style={{ margin: '0 0 20px', fontSize: 13.5, lineHeight: 1.6, color: '#6B7785' }}>
              {screen.blurb}
            </p>
          )}

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
                key={q.key} q={q} answers={answers}
                value={answers[q.key]}
                onChange={(v) => setAnswer(q.key, v)}
                onBlur={flush}
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

      {/* ── review + send ───────────────────────────────────────────────── */}
      {isReview && (
        <Card>
          <h2 style={{ margin: '0 0 6px', fontSize: 17.5, fontWeight: 700, color: BRAND.ink }}>
            Ready to send
          </h2>
          <p style={{ margin: '0 0 20px', fontSize: 13.5, lineHeight: 1.6, color: '#6B7785' }}>
            Have a read through. Nothing here is final — we'll talk it through with you,
            and you can print a copy for whoever else needs to see it.
          </p>
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
            <button type="button" onClick={submit} disabled={sending} style={{
              ...btnPrimary, background: sending ? '#9AC9DE' : '#16A34A',
              cursor: sending ? 'default' : 'pointer',
            }}>
              <Send size={15} /> {sending ? 'Sending…' : 'Send to Squideo'}
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

      {/* Print-only: the whole brief on one page, no chrome. */}
      <div className="brief-print">
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>
          {answers.projectName || 'Video brief'}
        </h1>
        <p style={{ fontSize: 12, color: '#666', marginTop: 0 }}>Video brief · Squideo</p>
        <BriefSummary answers={answers} print />
      </div>

      {data.past?.length > 0 && (
        <div className="brief-noprint" style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: '#6B7785', margin: '0 0 8px' }}>
            Briefs you've sent
          </h3>
          {data.past.map((p) => (
            <div key={p.id} style={{
              display: 'flex', justifyContent: 'space-between', gap: 12,
              padding: '10px 14px', background: '#fff', border: '1px solid #E8EEF3',
              borderRadius: 9, marginBottom: 6, fontSize: 13.5, color: BRAND.ink,
            }}>
              <span>{p.projectName}</span>
              <span style={{ color: '#9AA5B1', whiteSpace: 'nowrap' }}>
                {new Date(p.submittedAt).toLocaleDateString('en-GB')}
              </span>
            </div>
          ))}
        </div>
      )}
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
