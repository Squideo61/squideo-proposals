import { SQUIDEO_LOGO } from '../defaults.js';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtMoney(n) {
  return '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCredits(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function fmtValue(retainer, n) {
  return retainer.allocationType === 'money' ? fmtMoney(n) : fmtCredits(n) + ' credits';
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function buildRetainerHTML(retainer) {
  const total = retainer.allocationAmount;
  const used  = (retainer.entries || []).reduce((s, e) => s + Number(e.value || 0), 0);
  const remaining = total - used;
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const barColor = pct >= 90 ? '#DC2626' : pct >= 70 ? '#D97706' : '#16A34A';
  const isMoney = retainer.allocationType === 'money';

  const entriesRows = (retainer.entries || []).map(e => `
    <tr>
      <td style="padding:8px 10px;font-size:12px;color:#0F2A3D;border-bottom:1px solid #E5E9EE;">${esc(fmtDate(e.workedAt))}</td>
      <td style="padding:8px 10px;font-size:12px;color:#0F2A3D;border-bottom:1px solid #E5E9EE;">${esc(e.description)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#0F2A3D;border-bottom:1px solid #E5E9EE;text-align:right;white-space:nowrap;">${esc(fmtValue(retainer, e.value))}</td>
    </tr>
  `).join('');

  return `
    <div style="margin-bottom:32px;page-break-inside:avoid;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px;">
        <div>
          <h2 style="margin:0 0 4px;font-size:18px;font-weight:700;color:#0F2A3D;">${esc(retainer.title)}</h2>
          ${retainer.contactName ? `<div style="font-size:13px;color:#6B7785;">Contact: ${esc(retainer.contactName)}${retainer.contactEmail ? ` &lt;${esc(retainer.contactEmail)}&gt;` : ''}</div>` : ''}
          ${retainer.notes ? `<div style="font-size:12px;color:#6B7785;margin-top:4px;font-style:italic;">${esc(retainer.notes)}</div>` : ''}
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Total allocation</div>
          <div style="font-size:22px;font-weight:700;color:#0F2A3D;">${esc(fmtValue(retainer, total))}</div>
        </div>
      </div>

      <div style="background:#F8FAFC;border:1px solid #E5E9EE;border-radius:8px;padding:14px 16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:12px;color:#6B7785;">
          <span>Used: <strong style="color:#0F2A3D;">${esc(fmtValue(retainer, used))}</strong></span>
          <span>Remaining: <strong style="color:${remaining < 0 ? '#DC2626' : '#16A34A'};">${esc(fmtValue(retainer, remaining))}</strong></span>
        </div>
        <div style="background:#E5E9EE;border-radius:4px;height:8px;overflow:hidden;">
          <div style="background:${barColor};height:8px;width:${pct}%;border-radius:4px;"></div>
        </div>
        <div style="font-size:11px;color:#6B7785;margin-top:4px;text-align:right;">${pct}% used</div>
      </div>

      ${entriesRows ? `
      <table style="width:100%;border-collapse:collapse;border:1px solid #E5E9EE;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#F1F5F9;">
            <th style="padding:8px 10px;font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;text-align:left;border-bottom:1px solid #E5E9EE;">Date</th>
            <th style="padding:8px 10px;font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;text-align:left;border-bottom:1px solid #E5E9EE;">Description</th>
            <th style="padding:8px 10px;font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;text-align:right;border-bottom:1px solid #E5E9EE;">${isMoney ? 'Value' : 'Credits'}</th>
          </tr>
        </thead>
        <tbody>${entriesRows}</tbody>
        <tfoot>
          <tr style="background:#F8FAFC;">
            <td colspan="2" style="padding:8px 10px;font-size:12px;font-weight:700;color:#0F2A3D;border-top:2px solid #E5E9EE;">Total used</td>
            <td style="padding:8px 10px;font-size:12px;font-weight:700;color:#0F2A3D;text-align:right;border-top:2px solid #E5E9EE;white-space:nowrap;">${esc(fmtValue(retainer, used))}</td>
          </tr>
        </tfoot>
      </table>
      ` : '<p style="font-size:13px;color:#6B7785;font-style:italic;">No work logged yet.</p>'}
    </div>
  `;
}

export function openRetainerPrintWindow(retainer) {
  const logoSrc = SQUIDEO_LOGO;
  const generatedDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const body = buildRetainerHTML(retainer);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Project Retainer — ${esc(retainer.title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 40px; color: #0F2A3D; background: white; }
    @media print {
      body { padding: 20px; }
      .no-print { display: none !important; }
    }
    table { border-collapse: collapse; }
  </style>
</head>
<body>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #2BB8E6;">
    ${logoSrc ? `<img src="${esc(logoSrc)}" alt="Squideo" style="height:40px;object-fit:contain;" />` : '<strong style="font-size:20px;color:#2BB8E6;">Squideo</strong>'}
    <div style="text-align:right;">
      <div style="font-size:18px;font-weight:700;color:#0F2A3D;">Project Retainer Summary</div>
      <div style="font-size:12px;color:#6B7785;margin-top:2px;">Generated ${esc(generatedDate)}</div>
    </div>
  </div>

  ${body}

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #E5E9EE;font-size:11px;color:#6B7785;text-align:center;">
    This document is confidential and intended solely for the named client. Squideo Ltd.
  </div>

  <div class="no-print" style="margin-top:24px;text-align:center;">
    <button onclick="window.print()" style="padding:10px 24px;background:#2BB8E6;color:white;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">
      Print / Save as PDF
    </button>
  </div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=860,height=700,noopener');
  if (!win) return;
  win.document.write(html);
  win.document.close();
}
