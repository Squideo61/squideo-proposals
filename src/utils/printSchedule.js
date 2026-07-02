// Production Schedule → branded printable doc (Save-as-PDF), mirroring
// printProposal.js. Client-side only: build an HTML string, open a window,
// window.print(). No PDF library — the same pattern every other client doc uses.
import { SQUIDEO_LOGO } from '../defaults.js';
import { CONFIG } from '../theme.js';
import { FIELD_LABELS, FIELD_ORDER, enabledRows } from '../lib/scheduleTemplate.js';

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Local "YYYY-MM-DDTHH:mm" → "Mon 14 Jul, 17:00" for the doc. Blank → em dash.
function fmt(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || '');
  if (!m) return '—';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function buildScheduleHTML(schedule, deal, company, primaryContact) {
  const rows = enabledRows(schedule);
  // Which date columns appear at all (union across enabled rows), in fixed order.
  const activeFields = FIELD_ORDER.filter(f => rows.some(({ row }) => row.fields.includes(f)));

  // Group enabled rows by their section, preserving order.
  const bySection = [];
  for (const { section, row } of rows) {
    let bucket = bySection.find(b => b.section.id === section.id);
    if (!bucket) { bucket = { section, rows: [] }; bySection.push(bucket); }
    bucket.rows.push(row);
  }

  const headCells = ['Stage', ...activeFields.map(f => FIELD_LABELS[f])]
    .map(h => `<th style="text-align:left;padding:8px 10px;font-size:12px;font-weight:700;color:#0F2A3D;border-bottom:2px solid #2BB8E6;">${esc(h)}</th>`)
    .join('');

  const sectionsHTML = bySection.map(({ section, rows: srows }) => {
    const body = srows.map(row => {
      const cells = activeFields.map(f => {
        const v = row.fields.includes(f) ? fmt(row[f]) : '—';
        return `<td style="padding:8px 10px;font-size:13px;color:#0F2A3D;border-bottom:1px solid #E5E9EE;">${esc(v)}</td>`;
      }).join('');
      return `<tr><td style="padding:8px 10px;font-size:13px;font-weight:600;color:#0F2A3D;border-bottom:1px solid #E5E9EE;">${esc(row.label)}</td>${cells}</tr>`;
    }).join('');
    return `
      <h2 class="page-title">${esc(section.label)}</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <thead><tr>${headCells}</tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }).join('');

  const clientName = company?.name || deal?.title || '';
  const contactName = primaryContact?.name || '';
  const kickOff = schedule?.kickOff ? fmt(schedule.kickOff) : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Squideo Production Schedule - ${esc(clientName || 'Project')}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, system-ui, sans-serif; color: #0F2A3D; background: white; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
    @media screen {
      body { max-width: 820px; margin: 0 auto; padding: 32px 24px; }
    }
    .page-title { font-size: 18px; font-weight: 700; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #2BB8E6; }
    .muted { color: #6B7785; }
  </style>
</head>
<body>
  <div class="no-print" style="background:#FFF8E1;border:1px solid #FFE082;padding:12px 20px;text-align:center;font-size:13px;color:#8A6D00;margin-bottom:24px;border-radius:6px;">
    Use your browser's <strong>File → Print</strong> (or Ctrl+P / ⌘P) to save as PDF or print.
    <button onclick="window.print()" style="margin-left:16px;padding:6px 14px;background:#2BB8E6;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Print / Save as PDF</button>
  </div>

  <!-- Header -->
  <div style="background:#2BB8E6;color:white;padding:32px;border-radius:12px;margin-bottom:28px;">
    <img src="${SQUIDEO_LOGO}" alt="Squideo" style="height:44px;width:auto;display:block;margin-bottom:20px;" />
    <h1 style="font-size:26px;font-weight:700;margin:0 0 14px;line-height:1.2;">Production Schedule</h1>
    <div style="font-size:15px;line-height:1.6;opacity:0.95;">
      ${clientName ? `<div>Prepared for <strong>${esc(clientName)}</strong></div>` : ''}
      ${contactName ? `<div>Primary contact: <strong>${esc(contactName)}</strong></div>` : ''}
      ${deal?.title ? `<div>${esc(deal.title)}</div>` : ''}
      ${kickOff ? `<div style="margin-top:6px;font-size:13px;opacity:0.9;">Kick Off: <strong>${esc(kickOff)}</strong></div>` : ''}
    </div>
  </div>

  ${sectionsHTML || '<p class="muted">No schedule stages selected.</p>'}

  <!-- Disclaimer -->
  <div style="margin-top:32px;font-size:12px;font-style:italic;color:#6B7785;line-height:1.5;">
    Dates are subject to change depending on changes to schedules, or overall progress being halted and causing a delay.
  </div>

  <!-- Footer -->
  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #E5E9EE;font-size:11px;color:#6B7785;text-align:center;">
    ${esc(CONFIG.company.name)} · ${esc(CONFIG.company.website)} · ${esc(CONFIG.company.phone)}
  </div>
</body>
</html>`;
}

export function openSchedulePrintWindow(schedule, deal, company, primaryContact) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(buildScheduleHTML(schedule, deal, company, primaryContact));
  w.document.close();
  return true;
}
