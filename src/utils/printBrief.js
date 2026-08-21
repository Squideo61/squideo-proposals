// A finished video brief → a document worth forwarding.
//
// The button used to call window.print() on the portal page. That printed the
// portal: the nav rail, the header, the activity feed, the buttons. A client
// sending "here's our brief" to their MD was sending a screenshot of software,
// which is not what twenty minutes of work should turn into.
//
// So the brief gets built as its own document, the same way the proposal, the
// receipt, the schedule and the retainer already do — see printWindow.js for
// the shared plumbing and why the print button has to be wired from script.
//
// IT IS DESIGNED LIKE THE FORM IT CAME FROM. The numbered section discs are the
// stepper's circles; chip answers stay chips; the near-black headings, hairline
// cards and single restrained use of the accent are the form's own rules.
// Someone who filled the form in should recognise what comes out of it.
//
// IT IS ALSO A LEAD MAGNET THAT TRAVELS. A brief gets forwarded round a company
// — to whoever owns the message, whoever holds the budget, whoever signs it off.
// Every one of those people is a stranger reading a Squideo document, so it
// carries the logo, the colours, and one quiet line saying where it came from.
import { SQUIDEO_LOGO } from '../defaults.js';
import { CONFIG } from '../theme.js';
import { SCREENS, missingRequired, suggestedLength } from '../../api/_lib/brief/questions.js';
import { printButtonHTML, writeDoc } from './printWindow.js';

const INK = '#0F2A3D';
const BLUE = '#2BB8E6';
const MUTED = '#5C6B77';
const HAIR = '#E3E9EE';
const TINT = '#F0F9FF';

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The same emptiness test the form uses: a stray space bar is not an answer, and
// a document printing a blank line under a question looks like a fault.
const isBlank = (v) =>
  v == null ||
  (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && (v.length === 0 || v.every((r) => !r || (typeof r === 'object'
    ? !String(r.script || '').trim() && !String(r.visual || '').trim()
    : !String(r).trim()))));

const optionLabel = (q, v) => (q.options?.find((o) => o.value === v)?.label) || v;

// A chip answer stays a chip. The form let them pick from a set; flattening the
// choice into prose loses the fact that it was one of a few, which is exactly
// the context a producer skim-reading wants.
function pills(q, value) {
  const vals = Array.isArray(value) ? value : [value];
  return `<div class="pills">${vals
    .map((v) => `<span class="pill">${esc(optionLabel(q, v))}</span>`)
    .join('')}</div>`;
}

function scriptTable(rows) {
  const body = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && (String(r.script || '').trim() || String(r.visual || '').trim()))
    .map((r, i) => `
      <tr>
        <td class="scene"><span class="disc sm">${i + 1}</span></td>
        <td class="line">${esc(String(r.script || '').trim() || '—')}</td>
        <td class="line vis">${esc(String(r.visual || '').trim() || '—')}</td>
      </tr>`).join('');
  if (!body) return '';
  return `
    <table class="script">
      <thead><tr><th></th><th>What's said</th><th>What's on screen</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function answerHTML(q, value) {
  if (q.type === 'scriptTable') return scriptTable(value);
  if (q.options) return pills(q, value);
  return `<div class="answer">${esc(value)}</div>`;
}

// The handful of facts a producer reads before anything else. Deliberately
// short: a summary that repeats the whole brief is not a summary, and the full
// answers are four inches further down the page.
function factsHTML(answers) {
  const find = (key) => SCREENS.flatMap((s) => s.questions).find((q) => q.key === key);
  const suggested = suggestedLength(answers);
  const facts = [
    ['Goal', 'goal'],
    ['Audience', 'audience'],
    ['Length', 'length'],
    ['Deadline', 'deadline'],
    ['Budget', 'budget'],
    ['How many', 'volume'],
  ]
    .map(([label, key]) => {
      const q = find(key);
      let v = answers[key];
      // Length is the one fact we can fill in ourselves — it falls out of where
      // they said it would be seen. Marked as ours so nobody reads it as theirs.
      let ours = false;
      if (key === 'length' && isBlank(v) && suggested) { v = suggested; ours = true; }
      if (!q || isBlank(v)) return null;
      const text = q.options
        ? (Array.isArray(v) ? v.map((x) => optionLabel(q, x)).join(', ') : optionLabel(q, v))
        : String(v);
      // Long prose in a small box turns into a grey brick. This is the glance
      // version; the whole answer is in the body of the brief.
      const short = text.length > 92 ? `${text.slice(0, 90).trim()}…` : text;
      return `
        <div class="fact">
          <div class="fact-label">${esc(label)}${ours ? ' <span class="ours">suggested</span>' : ''}</div>
          <div class="fact-value">${esc(short)}</div>
        </div>`;
    })
    .filter(Boolean);
  return facts.length ? `<div class="facts">${facts.join('')}</div>` : '';
}

export function buildBriefHTML({ answers = {}, brief = {}, company = null, progress = null } = {}) {
  const project = brief.title || answers.projectName || 'Video brief';
  const finalised = !!brief.locked;
  const missing = missingRequired(answers);
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const submitted = brief.submittedAt
    ? new Date(brief.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  // Sections are numbered over the ones that made it in, so a brief that
  // skipped the optional script table doesn't jump from 5 to 7 and leave the
  // reader hunting for a page that was never there.
  let n = 0;
  // oneAction is printed in full as the hero panel a few inches above, so it is
  // dropped from its section. Repeating it verbatim on the same page reads as a
  // mistake rather than as emphasis — unlike the facts grid, which summarises.
  const sections = SCREENS.map((screen) => {
    const rows = screen.questions.filter((q) => q.key !== 'oneAction' && !isBlank(answers[q.key]));
    if (!rows.length) return '';
    n += 1;
    return `
      <section class="sec">
        <h2><span class="disc">${n}</span>${esc(screen.title)}</h2>
        ${rows.map((q) => `
          <div class="qa">
            <div class="q">${esc(q.label)}</div>
            ${answerHTML(q, answers[q.key])}
          </div>`).join('')}
      </section>`;
  }).join('');

  const status = finalised
    ? `<span class="badge final">Final${submitted ? ` · ${esc(submitted)}` : ''}</span>`
    : `<span class="badge draft">Draft${progress ? ` · ${progress.done} of ${progress.total} answered` : ''}</span>`;

  // A draft that doesn't say what is still missing is a draft somebody reads as
  // finished and quotes against.
  const outstanding = !finalised && missing.length
    ? `<div class="todo">
         <strong>Still to answer</strong>
         <span>${missing.map((m) => esc(m.label)).join(' · ')}</span>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Video brief — ${esc(project)}</title>
<style>
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: #EEF3F7; color: ${INK};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
    font-size: 14px; line-height: 1.6; letter-spacing: -0.01em;
    -webkit-font-smoothing: antialiased;
  }
  .sheet { max-width: 780px; margin: 0 auto; background: #fff; }
  @media screen {
    .sheet { margin: 26px auto 60px; border-radius: 18px; overflow: hidden;
             box-shadow: 0 1px 2px rgba(15,42,61,.05), 0 20px 60px rgba(15,42,61,.12); }
  }

  /* --- cover ------------------------------------------------------------ */
  .cover { background: ${INK}; color: #fff; padding: 40px 44px 34px; }
  .cover img { height: 34px; width: auto; display: block; margin-bottom: 30px; }
  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
             color: ${BLUE}; margin-bottom: 10px; }
  .cover h1 { margin: 0; font-size: 34px; line-height: 1.12; font-weight: 600; letter-spacing: -0.03em; }
  .meta { display: flex; flex-wrap: wrap; gap: 22px 42px; margin: 28px 0 0;
          padding-top: 22px; border-top: 1px solid rgba(255,255,255,.14); }
  .meta div { min-width: 0; }
  .meta dt { font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
             color: rgba(255,255,255,.5); margin-bottom: 5px; }
  .meta dd { margin: 0; font-size: 14.5px; font-weight: 500; color: #fff; }
  .badge { display: inline-block; padding: 3px 11px; border-radius: 999px;
           font-size: 12px; font-weight: 600; letter-spacing: 0; }
  .badge.final { background: rgba(74,222,128,.16); color: #86EFAC; }
  .badge.draft { background: rgba(255,255,255,.12); color: rgba(255,255,255,.85); }

  .body { padding: 36px 44px 40px; }

  /* --- the one thing, and the facts under it ---------------------------- */
  .hero { background: ${TINT}; border: 1px solid #CDE9F7; border-radius: 16px;
          padding: 22px 24px; margin-bottom: 20px; break-inside: avoid; page-break-inside: avoid; }
  .hero .q { font-size: 12px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
             color: #0B6E93; margin-bottom: 8px; }
  .hero p { margin: 0; font-size: 19px; line-height: 1.45; font-weight: 500;
            letter-spacing: -0.02em; white-space: pre-wrap; }
  .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
           background: ${HAIR}; border: 1px solid ${HAIR}; border-radius: 16px;
           overflow: hidden; margin-bottom: 34px; break-inside: avoid; page-break-inside: avoid; }
  .fact { background: #fff; padding: 14px 18px; }
  .fact-label { font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
                color: ${MUTED}; margin-bottom: 3px; }
  .fact-label .ours { text-transform: none; letter-spacing: 0; font-weight: 500;
                      color: #9AA5B1; font-size: 10px; }
  .fact-value { font-size: 14.5px; font-weight: 500; line-height: 1.45; }

  .todo { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline;
          background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 12px;
          padding: 12px 16px; margin-bottom: 24px; font-size: 12.5px; color: #8A6320; line-height: 1.5; }

  /* --- sections --------------------------------------------------------- */
  .sec { margin-bottom: 30px; }
  .sec h2 { display: flex; align-items: center; gap: 12px; margin: 0 0 14px;
            padding-bottom: 12px; border-bottom: 1px solid ${HAIR};
            font-size: 17px; font-weight: 600; letter-spacing: -0.02em;
            break-after: avoid; page-break-after: avoid; }
  /* The stepper's circles, kept. The form counted them through eight of these;
     the document that comes back is numbered the same way. */
  .disc { display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; flex: 0 0 26px; border-radius: 50%;
          background: ${BLUE}; color: #fff; font-size: 12.5px; font-weight: 600; letter-spacing: 0; }
  .disc.sm { width: 20px; height: 20px; flex-basis: 20px; font-size: 11px; }
  .qa { margin-bottom: 15px; break-inside: avoid; page-break-inside: avoid; }
  .q { font-size: 12.5px; color: ${MUTED}; margin-bottom: 3px; line-height: 1.45; }
  .answer { font-size: 14.5px; line-height: 1.6; white-space: pre-wrap; }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
  .pill { display: inline-block; padding: 3px 11px; border-radius: 999px;
          background: #EAF7FD; border: 1px solid #C6E4F2; color: #0B6E93;
          font-size: 13px; font-weight: 500; }

  table.script { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.script th { text-align: left; padding: 8px 10px; font-size: 10.5px; font-weight: 600;
                    letter-spacing: .1em; text-transform: uppercase; color: ${MUTED};
                    background: #F7F9FB; border-bottom: 1px solid ${HAIR}; }
  table.script td { padding: 10px; border-bottom: 1px solid ${HAIR}; vertical-align: top;
                    font-size: 13.5px; line-height: 1.55; }
  table.script tr { break-inside: avoid; page-break-inside: avoid; }
  td.scene { width: 34px; }
  td.line { white-space: pre-wrap; }
  td.vis { color: ${MUTED}; }

  /* --- close ------------------------------------------------------------ */
  .close { margin-top: 34px; padding-top: 20px; border-top: 1px solid ${HAIR};
           font-size: 12.5px; color: ${MUTED}; line-height: 1.6;
           break-inside: avoid; page-break-inside: avoid; }
  .close strong { color: ${INK}; }
  .close .rule { width: 34px; height: 2px; background: ${BLUE}; border-radius: 2px; margin-bottom: 14px; }

  /* Repeated at the foot of every printed page in Chrome, and once at the end
     of the document anywhere else. Either way a forwarded page says who made it. */
  .foot { font-size: 10.5px; color: #8A97A3; text-align: center; padding: 14px 0 0; }
  @media print {
    body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    @page { size: A4; margin: 13mm 0 16mm; }
    .sheet { max-width: none; margin: 0; box-shadow: none; border-radius: 0; }
    .cover { padding: 24px 16mm 22px; }
    .cover img { margin-bottom: 22px; }
    .cover h1 { font-size: 28px; }
    .body { padding: 26px 16mm 0; }
    .no-print { display: none !important; }
    .foot { position: fixed; bottom: -12mm; left: 0; right: 0; }
  }
</style>
</head>
<body>
  <div class="no-print" style="max-width:780px;margin:22px auto -8px;padding:12px 18px;background:#FFF8E1;border:1px solid #FFE082;border-radius:10px;font-size:13px;color:#8A6D00;text-align:center;">
    Use <strong>File &rarr; Print</strong> (Ctrl+P / &#8984;P) and choose <strong>Save as PDF</strong>.
    ${printButtonHTML()}
  </div>

  <div class="sheet">
    <div class="cover">
      <img src="${SQUIDEO_LOGO}" alt="Squideo" />
      <div class="eyebrow">Video brief</div>
      <h1>${esc(project)}</h1>
      <dl class="meta">
        ${company?.name ? `<div><dt>Prepared by</dt><dd>${esc(company.name)}</dd></div>` : ''}
        <div><dt>Project</dt><dd>${brief.dealTitle
          ? `${esc(brief.dealTitle)}${brief.dealReference ? ` · ${esc(brief.dealReference)}` : ''}`
          : 'New project'}</dd></div>
        <div><dt>Status</dt><dd>${status}</dd></div>
        <div><dt>${finalised ? 'Printed' : 'As at'}</dt><dd>${esc(today)}</dd></div>
      </dl>
    </div>

    <div class="body">
      ${outstanding}
      ${isBlank(answers.oneAction) ? '' : `
        <div class="hero">
          <div class="q">The one thing it has to do</div>
          <p>${esc(answers.oneAction)}</p>
        </div>`}
      ${factsHTML(answers)}
      ${sections || '<p style="color:#5C6B77;">Nothing has been answered yet.</p>'}

      <div class="close">
        <div class="rule"></div>
        ${finalised
          ? `<strong>This is the final version${brief.submittedBy ? `, finalised by ${esc(brief.submittedBy)}` : ''}.</strong> ${brief.dealSigned
              ? 'Our production team is working from this exact document.'
              : 'This version forms the basis of your quote — nothing goes into production until a proposal is signed.'} If something needs to change, tell us and we'll reopen it.`
          : '<strong>This is a working draft.</strong> It\'s still being filled in, so it may change before it reaches our production team.'}
      </div>
    </div>
  </div>

  <div class="foot">
    Built with the Squideo Online Brief Builder ·
    ${esc(CONFIG.company.name)} · ${esc(CONFIG.company.website)} · ${esc(CONFIG.company.phone)}
  </div>
</body>
</html>`;
}

export function openBriefPrintWindow(opts) {
  const w = window.open('', '_blank');
  if (!w) return false;
  writeDoc(w, buildBriefHTML(opts));
  return true;
}
