// The client's own video brief, on the deal it belongs to.
//
// The brief builder was a lead magnet: someone filled one in, it became a quote
// request, and that was the end of it. Clients then started sending briefs for
// work they had already signed — which had nowhere to land, so the answers sat
// in the portal and the team worked from an email instead.
//
// Now a brief names its project, so it shows here. Deliberately including
// DRAFTS: the expensive mistake is finding out at storyboard stage that the
// audience was never who we assumed, and a half-finished brief says that a
// fortnight earlier than a finished one.
//
// It also offers the company's UNFILED briefs. Every brief written before
// briefs could name a job is unfiled, and the migration deliberately doesn't
// guess which deal they belong to — an org with two projects would get a brief
// silently filed against the wrong one, and then finalising it would notify the
// wrong team. A person says instead, from the deal they're already looking at.
//
// Presentational only — fed by `briefs` / `unfiled` from
// /api/crm/portal-admin?dealId=…, which the Client portal card already loads.
import React, { useState } from 'react';
import {
  ClipboardList, ChevronDown, ChevronRight, Lock, Users, History, Link2, Clapperboard,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { formatRelativeTime } from '../../utils.js';

// How far through, at a glance. "22/25" is precise and unreadable — what you
// need off a collapsed row is whether this is finished enough to work from, so
// the fraction stays but only as detail behind a word.
const STATUS_PILL = {
  completed: { label: 'Completed',     bg: '#F0FDF4', border: '#BBF7D0', ink: '#15803D' },
  answered:  { label: 'All answered',  bg: '#EFF6FF', border: '#BFDBFE', ink: '#1D4ED8' },
  part:      { label: 'Part completed', bg: '#FFF8EB', border: '#F5C26B', ink: '#B45309' },
  empty:     { label: 'Not started',   bg: '#F1F5F9', border: BRAND.border, ink: BRAND.muted },
};

function StatusPill({ brief }) {
  const s = STATUS_PILL[brief.status] || STATUS_PILL.empty;
  // The fraction earns its place only mid-way through; on a finished brief it
  // just repeats the word, and on an empty one it reads as 0 of something.
  const detail = brief.status === 'part' ? ` · ${brief.done}/${brief.total}` : '';
  return (
    <span
      title={brief.status === 'completed'
        ? 'The client finalised and sent this brief'
        : brief.status === 'answered'
          ? 'Every question answered, but the client hasn’t sent it yet'
          : `${brief.done} of ${brief.total} questions answered`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px',
        borderRadius: 999, background: s.bg, border: `1px solid ${s.border}`,
        fontSize: 10.5, fontWeight: 800, color: s.ink, letterSpacing: 0.2, whiteSpace: 'nowrap',
      }}
    >
      {brief.status === 'completed' && <Lock size={9} />}
      {s.label}{detail}
    </span>
  );
}

// The brief, laid out so it can be read rather than decoded.
//
// renderBriefText() (api/_lib/brief/questions.js) emits a fixed shape, and the
// same string goes into the quote request and the team email — so this parses
// it here rather than the server sending HTML, keeping ONE rendering of a
// brief across all three.
//
//   ── SCREEN TITLE ──
//   The question
//     the answer, indented
//
// Split on blank lines and take the first line of each block as the question,
// the rest as the answer. That survives an answer containing its own newlines,
// which indentation alone does not: a client who presses Enter mid-answer would
// otherwise have half their paragraph rendered as bold questions.
function BriefText({ text }) {
  const blocks = String(text || '').split(/\n\s*\n/).filter((b) => b.trim());
  return (
    <div style={{
      fontSize: 12.5, lineHeight: 1.55, color: BRAND.ink,
      background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8,
      padding: '10px 12px', maxHeight: 340, overflowY: 'auto',
    }}>
      {blocks.map((block, i) => {
        const heading = block.trim().match(/^──\s*(.+?)\s*──$/);
        if (heading) {
          return (
            <div key={i} style={{
              fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
              color: BRAND.muted, margin: i === 0 ? '0 0 8px' : '16px 0 8px',
            }}>{heading[1]}</div>
          );
        }
        const lines = block.split('\n');
        // A block starting indented is the tail of an answer that had a blank
        // line in it — not a new question, so don't embolden it into one.
        const continuation = /^\s/.test(lines[0]);
        const question = continuation ? null : lines[0].trim();
        // Strip only the standard two-space answer indent. A script table nests
        // its "[visual]" lines deeper on purpose, and dedenting those to the
        // margin would lose which shot each one belongs to.
        const answer = (continuation ? lines : lines.slice(1))
          .map((l) => l.replace(/^ {1,2}/, ''))
          .join('\n')
          .trimEnd();
        return (
          <div key={i} style={{ margin: '0 0 10px' }}>
            {question && (
              <div style={{ fontWeight: 700, color: BRAND.ink }}>{question}</div>
            )}
            {answer && (
              <div style={{ whiteSpace: 'pre-wrap', color: BRAND.ink }}>{answer}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// The same answer, on the COLLAPSED section header — because "is the brief in
// yet, and how far?" is the question you open this card to settle, and having
// to expand two levels to find out defeats a summary row.
//
// One brief (nearly always) shows its own pill verbatim, fraction included, so
// the header says exactly what the row would. Several collapse to counts —
// listing four pills side by side is noisier than the thing it summarises.
function BriefSummary({ briefs = [] }) {
  if (!briefs.length) return null;
  if (briefs.length === 1) return <StatusPill brief={briefs[0]} />;

  const counts = {};
  for (const b of briefs) counts[b.status] = (counts[b.status] || 0) + 1;
  const parts = ['completed', 'answered', 'part', 'empty']
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${STATUS_PILL[k].label.toLowerCase()}`);
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted }}>{parts.join(' · ')}</span>
  );
}

function BriefRow({ brief, videos = [], onSetVideo, busy = false }) {
  const [open, setOpen] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  return (
    <div style={{ borderBottom: '1px solid ' + BRAND.border }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          padding: '8px 0', background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {open ? <ChevronDown size={13} color={BRAND.muted} /> : <ChevronRight size={13} color={BRAND.muted} />}
        {/* One line, always. A brief's title is whatever the client typed as
            the project name, and people paste a whole script in there — which
            would push the FINAL pill and the progress count off a row that is
            meant to be the collapsed summary. The full text is in the answers
            below, one click away. */}
        <span
          title={brief.title || ''}
          style={{
            flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: BRAND.ink,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {brief.title}
        </span>
        {/* Which video this brief describes. A single-video project shows it
            too — it costs a few characters and removes the question. */}
        {brief.videoTitle && (
          <span
            title={brief.videoAssumed
              ? 'Nobody has said which video this brief is for, so it’s shown against the first one'
              : `This brief is for ${brief.videoTitle}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
              color: BRAND.muted, whiteSpace: 'nowrap', fontWeight: 600,
            }}
          >
            <Clapperboard size={11} />
            {brief.videoTitle}{brief.videoAssumed ? '?' : ''}
          </span>
        )}
        <StatusPill brief={brief} />
        {brief.contributors > 1 && (
          <span style={{ fontSize: 11.5, color: BRAND.muted, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Users size={11} />{brief.contributors}
          </span>
        )}
      </button>

      {open && (
        <div style={{ padding: '2px 0 12px 21px' }}>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 8 }}>
            {brief.locked
              ? `Finalised${brief.submittedBy ? ` by ${brief.submittedBy}` : ''} ${formatRelativeTime(brief.submittedAt)}`
              : `Still a draft — last edited ${formatRelativeTime(brief.updatedAt)}. This may still change.`}
            {brief.reopenedAt && ' · reopened by Squideo'}
          </div>

          {/* Which video it's for. Only offered when there's a choice to make —
              on a single-video project the label above already says it, and a
              dropdown with one option is a question with one answer. */}
          {onSetVideo && videos.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8, fontSize: 11.5 }}>
              <Clapperboard size={12} color={BRAND.muted} />
              <span style={{ color: BRAND.muted }}>This brief is for</span>
              <select
                className="input"
                disabled={busy}
                value={brief.videoAssumed ? '' : (brief.videoId || '')}
                onChange={(e) => onSetVideo(brief, e.target.value || null)}
                style={{ fontSize: 11.5, padding: '2px 6px', width: 'auto' }}
              >
                <option value="">Not said — assuming {videos[0]?.title}</option>
                {videos.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
              </select>
            </div>
          )}

          {brief.text ? (
            <BriefText text={brief.text} />
          ) : (
            <div style={{ fontSize: 12.5, color: BRAND.muted, fontStyle: 'italic' }}>
              Started, but nothing answered yet.
            </div>
          )}

          {brief.activity?.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowActivity((v) => !v)}
                aria-expanded={showActivity}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8,
                  background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                  color: BRAND.blue, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                }}
              >
                <History size={12} />
                {showActivity ? 'Hide' : 'Who changed what'}
              </button>
              {showActivity && (
                <div style={{ marginTop: 6 }}>
                  {brief.activity.map((e) => (
                    <div key={e.id} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 11.5 }}>
                      <span style={{ flex: 1, minWidth: 0, color: BRAND.ink }}>{e.text}</span>
                      <span style={{ color: BRAND.muted, whiteSpace: 'nowrap' }}>
                        {formatRelativeTime(e.at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// A brief this company wrote that names no project. Offered here rather than
// anywhere central because this is where you're standing when you realise it
// belongs to the job in front of you.
function UnfiledRow({ brief, onAttach, busy }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
      borderBottom: '1px solid ' + BRAND.border, fontSize: 13,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {brief.title}
        </div>
        <div style={{ fontSize: 11.5, color: BRAND.muted }}>
          {brief.locked ? 'Final' : `${brief.done} of ${brief.total} answered`}
          {' · '}edited {formatRelativeTime(brief.updatedAt)}
          {brief.contributors > 1 && ` · ${brief.contributors} people`}
        </div>
      </div>
      <button
        className="btn-ghost"
        disabled={busy}
        style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}
        title="File this brief against this project — it then shows on the deal and reaches this project's team"
        onClick={() => onAttach(brief)}
      >
        <Link2 size={12} /> It&rsquo;s for this project
      </button>
    </div>
  );
}

export function ClientBriefBlock({ briefs = [], unfiled = [], videos = [], onAttach, onSetVideo, busy = false }) {
  const [open, setOpen] = useState(false);
  if (!briefs.length && !unfiled.length) return null;


  return (
    <div style={{ marginTop: 12, borderTop: '1px solid ' + BRAND.border, paddingTop: 4 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide the client’s brief' : 'Read the brief the client wrote for this project'}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, width: '100%', padding: '6px 0',
          background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          textAlign: 'left', fontSize: 11, fontWeight: 700, color: BRAND.muted,
          textTransform: 'uppercase', letterSpacing: 0.5,
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ClipboardList size={12} />
        Client brief
        {briefs.length > 0 && <span style={{ opacity: 0.75 }}>· {briefs.length}</span>}
        {/* Beside the label, not flung to the right margin: the state belongs
            with the thing it describes, and across a wide card the eye has to
            travel back to work out what a lone pill refers to. */}
        <span style={{ marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
          {/* An unfiled brief is the thing worth saying on a collapsed row: a
              draft you already know about is just progress, but a brief sitting
              on the company with no project named is one nobody has read. */}
          {unfiled.length > 0 ? (
            <span style={{ color: BRAND.blue, fontWeight: 700 }}>
              {unfiled.length} unfiled — could be this project
            </span>
          ) : (
            <BriefSummary briefs={briefs} />
          )}
        </span>
      </button>

      {open && (
        <>
          {briefs.map((b) => (
            <BriefRow key={b.id} brief={b} videos={videos} onSetVideo={onSetVideo} busy={busy} />
          ))}

          {/* Filing a stray brief onto this deal is a WRITE, so the whole
              section depends on being handed a handler. A read-only viewer
              (portal.preview without portal-admin) gets the briefs themselves
              — which is the point — but not the button that would 403. */}
          {onAttach && unfiled.length > 0 && (
            <div style={{ marginTop: briefs.length ? 10 : 4 }}>
              <div style={{
                fontSize: 10.5, fontWeight: 700, color: BRAND.muted, letterSpacing: 0.4,
                textTransform: 'uppercase', marginBottom: 2,
              }}>
                Not filed to a project
              </div>
              <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 6, lineHeight: 1.5 }}>
                {briefs.length
                  ? 'Also on this company.'
                  : 'This client has briefed something, but hasn’t said which project it’s for.'}{' '}
                Filing one here puts it on this deal and sends it to this project’s team when they finalise it.
              </div>
              {unfiled.map((b) => (
                <UnfiledRow key={b.id} brief={b} onAttach={onAttach} busy={busy} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
