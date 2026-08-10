// Org-level documents: brand guidelines (logos, fonts, tone-of-voice) and
// general documents. Per-project docs live on each project page.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi, mediaUrl } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, FileRow, fmtBytes, fmtDate } from '../components.jsx';
import {
  Palette, Upload, FolderOpen, FileText, Download, Trash2, CheckCircle2,
  Eye, X, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { PdfThumb } from '../../components/storyboard/PdfThumb.jsx';

const isImage = (f) => (f.mimeType || '').startsWith('image/');
const isPdf = (f) => (f.mimeType || '') === 'application/pdf'
  || /\.pdf$/i.test(f.filename || '');

// The cover: the document's actual first page, or the image itself.
//
// A red PDF glyph tells a client we hold "a file". Their brand guidelines
// rendered on the page tells them we hold THE file — which is the entire
// question they came to this page to answer. It falls back to the glyph if the
// PDF can't be rendered (an encrypted or damaged file, or a blocked fetch),
// because a broken tile would answer it worse than the icon did.
function FileCover({ file, url, width = 92, height = 116 }) {
  const [pdfStatus, setPdfStatus] = useState('loading');
  const pdf = isPdf(file);
  const image = isImage(file);
  const showGlyph = (!pdf && !image) || (pdf && pdfStatus === 'error');

  return (
    <div style={{
      width, height, flexShrink: 0, borderRadius: 8, overflow: 'hidden',
      display: 'flex', justifyContent: 'center',
      // A page is taller than this box, so it gets cropped — from the bottom,
      // because the top of a brand document is where the logo and title are.
      alignItems: pdf && !showGlyph ? 'flex-start' : 'center',
      // White for documents (they're pages), a soft tile for images (most logos
      // are transparent and would vanish on white).
      background: image ? '#F4F7F9' : '#fff',
      border: `1px solid ${BRAND.border}`,
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.6)',
    }}>
      {image ? (
        <img src={url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} />
      ) : pdf && !showGlyph ? (
        <div style={{ width: '100%', height: '100%', overflow: 'hidden', display: 'flex', justifyContent: 'center' }}>
          <PdfThumb url={url} width={width} onStatus={setPdfStatus} />
        </div>
      ) : (
        <FileText size={28} color={pdf ? '#DC2626' : BRAND.muted} />
      )}
    </div>
  );
}

// Full-size look at a brand file without leaving the portal. Downloading a
// 10MB PDF just to check it's the right one is the friction this removes.
//
// Not dismissable by backdrop click — same rule as every other dialog here.
function FilePreview({ file, url, onClose }) {
  const [pages, setPages] = useState(null);
  const [page, setPage] = useState(1);
  const pdf = isPdf(file);
  // Re-measured on resize so rotating a phone doesn't leave the page rendered
  // at the old width, cropped or stranded in the middle.
  const [pageWidth, setPageWidth] = useState(() => Math.min(820, window.innerWidth - 96));
  useEffect(() => {
    const onResize = () => setPageWidth(Math.min(820, window.innerWidth - 96));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!pdf) return undefined;
    let alive = true;
    // loadPdf memoises by url, so the cover already paid for this fetch.
    import('../../lib/pdf.js')
      .then((m) => m.loadPdf(url))
      .then((doc) => { if (alive) setPages(doc.numPages); })
      .catch(() => { if (alive) setPages(0); });
    return () => { alive = false; };
  }, [pdf, url]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (!pdf || !pages) return;
      if (e.key === 'ArrowRight') setPage((p) => Math.min(pages, p + 1));
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(1, p - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pdf, pages, onClose]);

  const navBtn = (disabled) => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 34, height: 34, borderRadius: '50%', border: `1px solid ${BRAND.border}`,
    background: '#fff', color: BRAND.ink, padding: 0,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
  });

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(15,42,61,.6)' }} />
      <div style={{
        position: 'fixed', inset: 0, zIndex: 71, display: 'flex', flexDirection: 'column',
        padding: 'clamp(12px, 3vw, 32px)', pointerEvents: 'none',
      }}>
        <div style={{
          pointerEvents: 'auto', margin: '0 auto', width: '100%', maxWidth: 900,
          display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1,
          background: '#fff', borderRadius: 14, overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(15,42,61,.35)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
            borderBottom: `1px solid ${BRAND.border}`, flexShrink: 0,
          }}>
            <FileText size={17} color={BRAND.blue} style={{ flexShrink: 0 }} />
            <strong style={{
              flex: 1, minWidth: 0, fontSize: 14, color: BRAND.ink,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {file.filename}
            </strong>
            <a
              href={url}
              className="btn-ghost"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, textDecoration: 'none', flexShrink: 0 }}
            >
              <Download size={14} /> Download
            </a>
            <button
              type="button" aria-label="Close" onClick={onClose}
              style={{ background: 'none', border: 'none', padding: 6, cursor: 'pointer', color: BRAND.muted, display: 'flex', flexShrink: 0 }}
            >
              <X size={18} />
            </button>
          </div>

          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto', background: '#F4F7F9',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16,
          }}>
            {pdf ? (
              // Fixed pixel width (the canvas can't be sized in CSS without
              // going blurry), so it's measured against the viewport once.
              <PdfThumb key={`${page}:${pageWidth}`} url={url} pageNumber={page} width={pageWidth} />
            ) : (
              <img src={url} alt={file.filename} style={{ maxWidth: '100%', display: 'block', borderRadius: 6 }} />
            )}
          </div>

          {pdf && pages > 1 && (
            <div style={{
              flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
              padding: '10px 14px', borderTop: `1px solid ${BRAND.border}`,
            }}>
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} title="Previous page" style={navBtn(page <= 1)}>
                <ChevronLeft size={18} />
              </button>
              <span style={{ fontSize: 13, color: BRAND.ink, minWidth: 74, textAlign: 'center' }}>
                <strong>{page}</strong><span style={{ color: BRAND.muted }}> / {pages}</span>
              </span>
              <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} title="Next page" style={navBtn(page >= pages)}>
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// A brand file, presented rather than listed.
//
// These are the documents a client is most likely to check we actually have —
// so this row exists to answer that at a glance: what it is, that it's the
// right one (an image shows itself), and who put it there. The plain FileRow
// the Documents tab uses is right for a pile of attachments; it is not right
// for the one thing on the page a client came to verify.
function BrandFile({ file, url, onPreview, onDownload, onDelete }) {
  const previewable = isPdf(file) || isImage(file);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: 14,
      border: `1px solid ${BRAND.border}`, borderRadius: 12, background: '#fff',
    }}>
      <button
        type="button"
        onClick={previewable ? onPreview : onDownload}
        title={previewable ? 'Open preview' : 'Download'}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', flexShrink: 0 }}
      >
        <FileCover file={file} url={url} />
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: BRAND.ink,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {file.filename}
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 3, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span>{[file.sizeBytes != null ? fmtBytes(file.sizeBytes) : null, fmtDate(file.createdAt)].filter(Boolean).join(' · ')}</span>
          {/* The client didn't put this here — we did, from manage mode. Saying
              so is the whole point: it reads as "they're on it", where an
              unattributed file reads as one they forgot uploading. */}
          {file.uploadedByStaff ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: '#EAF6FB', color: '#0B6E93', border: '1px solid #BFE0EE',
              borderRadius: 999, padding: '1px 9px', fontSize: 11, fontWeight: 700,
            }}>
              Added by Squideo
            </span>
          ) : file.uploadedByName ? (
            <span>by {file.uploadedByName}</span>
          ) : null}
        </div>
      </div>

      {previewable && (
        <button className="btn-ghost" onClick={onPreview} style={{ padding: '7px 12px', flexShrink: 0, fontSize: 12.5, fontWeight: 700, color: BRAND.blue }}>
          <Eye size={14} style={{ verticalAlign: -2, marginRight: 5 }} />Preview
        </button>
      )}
      <button className="btn-ghost" onClick={onDownload} title="Download" style={{ padding: '7px 11px', flexShrink: 0 }}>
        <Download size={15} />
      </button>
      {onDelete && (
        <button className="btn-ghost" onClick={onDelete} title="Remove" style={{ padding: '7px 11px', color: '#DC2626', flexShrink: 0 }}>
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}

function UploadZone({ onFiles, uploading, label }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(Array.from(e.dataTransfer.files || [])); }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${drag ? BRAND.blue : BRAND.border}`,
        background: drag ? BRAND.blue + '0d' : '#FAFBFC',
        borderRadius: 12, padding: '26px 16px', textAlign: 'center', cursor: 'pointer',
        transition: 'all 0.15s ease',
      }}
    >
      <Upload size={22} color={drag ? BRAND.blue : BRAND.muted} />
      <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginTop: 8 }}>
        {uploading ? 'Uploading…' : label}
      </div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
        Drag & drop or click — PDF, docs, images, fonts, zips (max 20 MB each)
      </div>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        disabled={uploading}
        onChange={(e) => { onFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
      />
    </div>
  );
}

export default function Documents() {
  const { companyId, showToast, isProspect, manageMode } = usePortal();
  const [files, setFiles] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState('brand'); // 'brand' | 'document'
  const [preview, setPreview] = useState(null); // { file, url } | null

  const load = useCallback(async () => {
    if (!companyId) return;
    const data = await portalApi.get(`files?companyId=${encodeURIComponent(companyId)}`);
    setFiles(data.files || []);
  }, [companyId]);

  useEffect(() => { load().catch((err) => showToast(err.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (list) => {
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list.slice(0, 10)) {
        // eslint-disable-next-line no-await-in-loop
        await portalApi.upload(`files?companyId=${encodeURIComponent(companyId)}&category=${tab}`, file);
      }
      showToast(manageMode
        ? 'Uploaded ✓ — the client can see it in their portal now'
        : 'Uploaded ✓ — our team can see it now');
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id) => {
    try {
      await portalApi.delete(`files?id=${encodeURIComponent(id)}`);
      await load();
    } catch (err) {
      showToast(err.message);
    }
  };

  const visible = (files || []).filter((f) => (f.category || 'brand') === tab);
  const tabStyle = (active) => ({
    padding: '8px 16px', borderRadius: 999, border: 'none', cursor: 'pointer',
    fontSize: 13, fontWeight: 700,
    background: active ? BRAND.ink : '#F1F4F7',
    color: active ? '#fff' : BRAND.muted,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Documents & brand</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13.5, color: BRAND.muted }}>
          {isProspect
            ? 'Share your brand guidelines and documents once — whoever ends up working on your project will already have them.'
            : 'Share your brand guidelines and documents once — our whole team uses them across every project.'}
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={tabStyle(tab === 'brand')} onClick={() => setTab('brand')}>
          <Palette size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Brand guidelines
        </button>
        <button style={tabStyle(tab === 'document')} onClick={() => setTab('document')}>
          <FolderOpen size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Documents
        </button>
      </div>

      {/* The receipt. A client who sent their guidelines over email months ago
          has no way of knowing they landed anywhere useful, and asking again is
          the kind of small friction that makes an agency feel disorganised.
          This is the page they'd come to check, so it answers first. */}
      {tab === 'brand' && visible.length > 0 && (
        <div style={{
          display: 'flex', gap: 11, alignItems: 'flex-start', padding: '13px 15px',
          borderRadius: 12, background: '#F3FBF6', border: '1px solid #9BE0B7',
          fontSize: 13.5, lineHeight: 1.55, color: '#15803D',
        }}>
          <CheckCircle2 size={17} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong style={{ color: BRAND.ink }}>
              We've got your brand {visible.length === 1 ? 'file' : 'files'}.
            </strong>{' '}
            {manageMode
              ? 'The client sees this confirmation too — every project we make for them works from these.'
              : 'Every project we make for you works from these, so you should never have to send them twice.'}
          </div>
        </div>
      )}

      <Card>
        <UploadZone
          onFiles={upload}
          uploading={uploading}
          label={manageMode
            ? (tab === 'brand'
              ? "Upload brand guidelines on the client's behalf"
              : "Upload a document on the client's behalf")
            : (tab === 'brand' ? 'Upload brand guidelines, logos or fonts' : 'Upload a document')}
        />
        {/* Manage mode is the whole reason this path exists: a client who emails
            their guidelines to a producer should end up with them filed here,
            not in a thread. Saying it plainly stops anyone wondering whether
            this lands as "the client uploaded it". */}
        {manageMode && (
          <div style={{ fontSize: 12.5, color: '#B45309', marginTop: 10, lineHeight: 1.5 }}>
            Uploaded here, these show in the client's own portal marked
            {' '}<strong>Added by Squideo</strong> — and tick off their
            &ldquo;{tab === 'brand' ? 'Upload your brand guidelines & logo' : 'Documents'}&rdquo; task.
          </div>
        )}
        <div style={{ marginTop: 18 }}>
          {files === null ? (
            <div style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', padding: 10 }}>Loading…</div>
          ) : visible.length === 0 ? (
            /* Unlike the library, this page genuinely works before there's a
               project — anything dropped here now saves a round trip on the
               first one. So a prospect gets a reason to use it today, not a
               "come back later". */
            <EmptyState
              icon={tab === 'brand' ? <Palette size={34} /> : <FolderOpen size={34} />}
              title={tab === 'brand' ? 'No brand files yet' : 'No documents yet'}
              body={tab === 'brand'
                ? (isProspect
                  ? 'Logos, fonts, colour palettes, tone-of-voice docs. Adding them now means your first video looks like you from the very first draft, rather than after a round of notes.'
                  : 'Logos, fonts, colour palettes, tone-of-voice docs — anything that helps us nail your brand.')
                : (isProspect
                  ? "Anything you'd want our team to have on hand — a deck, an existing script, a video you like. It all goes to whoever ends up working on your project."
                  : 'Anything else you want our team to have on hand.')}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {visible.map((f) => {
                const url = mediaUrl(`download?scope=company&id=${encodeURIComponent(f.id)}`);
                // Brand files get the richer card; general documents stay a
                // plain row — a pile of attachments doesn't need thumbnails.
                return tab === 'brand' ? (
                  <BrandFile
                    key={f.id}
                    file={f}
                    url={url}
                    onPreview={() => setPreview({ file: f, url })}
                    onDownload={() => { window.location.href = url; }}
                    onDelete={() => remove(f.id)}
                  />
                ) : (
                  <FileRow
                    key={f.id}
                    filename={f.filename}
                    sizeBytes={f.sizeBytes}
                    createdAt={f.createdAt}
                    meta={f.uploadedByStaff ? 'added by Squideo' : f.uploadedByName ? `by ${f.uploadedByName}` : null}
                    onDownload={() => { window.location.href = url; }}
                    onDelete={() => remove(f.id)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {preview && (
        <FilePreview file={preview.file} url={preview.url} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
