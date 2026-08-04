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
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState } from '../components.jsx';
import { navigate } from '../PortalApp.jsx';
import {
  SCREENS, briefProgress, missingRequired, suggestedLength,
} from '../../../api/_lib/brief/questions.js';

const SAVE_DEBOUNCE_MS = 900;

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
const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '11px 13px',
  border: '1px solid #D8E0E8', borderRadius: 9, fontSize: 14.5,
  fontFamily: 'inherit', color: BRAND.ink, background: '#fff', lineHeight: 1.5,
};

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
  const rows = Array.isArray(value) && value.length ? value : [{ script: '', visual: '' }];
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} style={{
          display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10,
          alignItems: 'flex-start',
        }}>
          <textarea
            value={r.script || ''} rows={3}
            onChange={(e) => set(i, 'script', e.target.value)}
            placeholder={i === 0 ? 'What is said…' : ''}
            style={{ ...inputStyle, flex: '1 1 240px', resize: 'vertical' }}
          />
          <textarea
            value={r.visual || ''} rows={3}
            onChange={(e) => set(i, 'visual', e.target.value)}
            placeholder={i === 0 ? 'What is on screen…' : ''}
            style={{ ...inputStyle, flex: '1 1 240px', resize: 'vertical' }}
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

function Question({ q, value, onChange, answers, invalid }) {
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

      {q.type === 'text' && (
        <input
          type="text" value={value || ''} placeholder={q.placeholder || ''}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, borderColor: invalid ? '#E9A0A0' : '#D8E0E8' }}
        />
      )}
      {q.type === 'textarea' && (
        <textarea
          value={value || ''} rows={q.rows || 3} placeholder={q.placeholder || ''}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, resize: 'vertical', borderColor: invalid ? '#E9A0A0' : '#D8E0E8' }}
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
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [answers, setAnswers] = useState({});
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [sending, setSending] = useState(false);
  const [showInvalid, setShowInvalid] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);

  const pending = useRef({});
  const timer = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const d = await portalApi.get('brief');
        setData(d);
        setAnswers(d.brief?.answers || {});
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
    } catch {
      // Deliberately silent. The value is still in state and will go up with
      // the next edit; a red banner over a half-typed sentence helps nobody.
      Object.assign(pending.current, patch);
    } finally { setSaving(false); }
  }, []);

  const setAnswer = useCallback((key, value) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    pending.current[key] = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Don't lose the last few keystrokes to a tab close or a nav away.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
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
      const d = await portalApi.get('brief');
      setData(d);
      setAnswers(d.brief?.answers || {});
      setStep(0);
    } catch (err) {
      showToast(err.message || "Couldn't send the brief", 'error');
    } finally { setSending(false); }
  };

  if (error) return <EmptyState title="Couldn't open your brief" body={error} />;
  if (!data) return <div style={{ padding: 32, color: '#6B7785' }}>Loading…</div>;

  const saveLabel = saving ? 'Saving…'
    : savedAt ? `Saved ${savedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : 'Saves as you type';

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
          <span style={{ whiteSpace: 'nowrap', color: saving ? BRAND.blue : '#9AA5B1' }}>{saveLabel}</span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {screens.map((s, i) => (
            <button
              key={s.key} type="button" onClick={() => setStep(i)}
              style={{
                padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
                fontSize: 12, fontFamily: 'inherit',
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
