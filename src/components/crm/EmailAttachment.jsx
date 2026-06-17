import React from 'react';
import { Download, FileText, Image as ImageIcon, File, FileSpreadsheet, FileArchive } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { PdfThumb } from '../storyboard/PdfThumb.jsx';

// Gmail-style attachment preview cards for the email viewers: a thumbnail
// (image preview / PDF first-page render / a file-type icon) over a filename +
// size footer, with a hover download button. Bytes come from the same Gmail
// attachment endpoint the old chip used; `disposition=inline` lets images/PDFs
// render in-place and open as a preview rather than forcing a download.

const CARD_W = 200;
const PREVIEW_H = 112;

function attachmentUrl(messageId, att, disposition) {
  const params = new URLSearchParams({
    messageId,
    attachmentId: att.attachmentId,
    filename: att.filename || 'attachment',
    mimeType: att.mimeType || 'application/octet-stream',
  });
  if (disposition) params.set('disposition', disposition);
  return '/api/crm/gmail/attachment?' + params.toString();
}

function kindOf(att) {
  const mt = (att.mimeType || '').toLowerCase();
  const name = (att.filename || '').toLowerCase();
  if (mt.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/.test(name)) return 'image';
  if (mt === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (/spreadsheet|excel|csv/.test(mt) || /\.(xlsx?|csv|numbers)$/.test(name)) return 'sheet';
  if (/zip|compressed|tar|rar/.test(mt) || /\.(zip|rar|7z|tar|gz)$/.test(name)) return 'archive';
  return 'other';
}

const ICON_FOR = { image: ImageIcon, pdf: FileText, sheet: FileSpreadsheet, archive: FileArchive, other: File };

function fileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function EmailAttachmentCard({ att, messageId, connected }) {
  const usable = !!(connected && att.attachmentId && messageId);
  const kind = kindOf(att);
  const openUrl = usable ? attachmentUrl(messageId, att, 'inline') : null;
  const downloadUrl = usable ? attachmentUrl(messageId, att, 'attachment') : null;
  const Icon = ICON_FOR[kind] || File;
  const size = fileSize(att.size ?? att.sizeBytes);

  let preview;
  if (usable && kind === 'image') {
    preview = (
      <img
        src={openUrl}
        alt={att.filename || ''}
        loading="lazy"
        style={{ width: '100%', height: PREVIEW_H, objectFit: 'cover', display: 'block', background: '#F1F5F9' }}
      />
    );
  } else if (usable && kind === 'pdf') {
    preview = (
      <div style={{ height: PREVIEW_H, overflow: 'hidden', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', background: '#F1F5F9' }}>
        <PdfThumb url={openUrl} width={CARD_W} />
      </div>
    );
  } else {
    preview = (
      <div style={{ height: PREVIEW_H, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F1F5F9' }}>
        <Icon size={34} color={BRAND.muted} />
      </div>
    );
  }

  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 9px', borderTop: '1px solid ' + BRAND.border }}>
      <Icon size={14} color={BRAND.muted} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={att.filename}>
          {att.filename || 'attachment'}
        </div>
        {size && <div style={{ fontSize: 10.5, color: BRAND.muted }}>{size}</div>}
      </div>
    </div>
  );

  return (
    <div style={{ position: 'relative', width: CARD_W, border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden', background: 'white' }}>
      {openUrl ? (
        <a href={openUrl} target="_blank" rel="noreferrer" title={'Open ' + (att.filename || '')}
           style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          {preview}
          {footer}
        </a>
      ) : (
        <div title="Connect Gmail to open this attachment">{preview}{footer}</div>
      )}
      {downloadUrl && (
        // Sibling of the open-link (not nested) so it's a separate, valid anchor.
        <a href={downloadUrl} target="_blank" rel="noreferrer" title="Download"
           style={{ position: 'absolute', top: 6, right: 6, display: 'flex', padding: 5, borderRadius: 6,
             background: 'rgba(255,255,255,0.92)', border: '1px solid ' + BRAND.border, color: BRAND.blue }}>
          <Download size={14} />
        </a>
      )}
    </div>
  );
}
