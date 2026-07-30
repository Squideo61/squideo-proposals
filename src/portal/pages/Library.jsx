// The video library: everything we've delivered this client — the approved cut
// from each project, finished renders from its Drive "Signed Off" folder, and
// past work staff have added by hand. Each video plays right here; every file
// has its own download button.
//
// In manage mode (staff inside the client's portal) an upload panel appears at
// the top for adding back-catalogue videos, and hand-added items can be removed.
import React, { useEffect, useRef, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi, mediaUrl } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, fmtBytes, fmtDate } from '../components.jsx';
import { Film, Download, Clapperboard, Upload, Trash2, PlusCircle } from 'lucide-react';

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv|avi|mkv)$/i;

// A Drive listing can hold stills, PDFs and scripts alongside the renders, so
// only the actual videos get a player.
const isVideo = (f) =>
  (f.mimeType || '').startsWith('video/') || VIDEO_EXT.test(f.name || '') || f.kind === 'cut';

// One URL builder for all three sources. `download` asks for an attachment
// disposition; without it the same URL is what the <video> tag streams.
function fileUrl(dealId, f, { download = false } = {}) {
  const q = (s) => encodeURIComponent(s);
  if (f.kind === 'cut') {
    return mediaUrl(`download?scope=cut&dealId=${q(dealId)}&videoId=${q(f.videoId)}${download ? '&download=1' : ''}`);
  }
  if (f.kind === 'archive') {
    return mediaUrl(`download?scope=archive&id=${q(f.itemId)}${download ? '&download=1' : ''}`);
  }
  // Drive streams through us either way — inline for the player, attachment for
  // the download button.
  return mediaUrl(`download?scope=library&dealId=${q(dealId)}&id=${q(f.fileId)}${download ? '' : '&inline=1'}`);
}

export default function Library() {
  const { companyId, manageMode, showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    if (!companyId) return;
    portalApi.get(`library?companyId=${encodeURIComponent(companyId)}`)
      .then(setData)
      .catch((err) => setError(err.message));
  };

  useEffect(() => { setData(null); setError(null); load(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeItem = async (f) => {
    if (!window.confirm(`Remove “${f.name}” from the client's library?`)) return;
    try {
      await portalApi.delete(`library-item?companyId=${encodeURIComponent(companyId)}&id=${encodeURIComponent(f.itemId)}`);
      showToast('Removed ✓');
      load();
    } catch (err) {
      showToast(err.message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Your video library</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13.5, color: BRAND.muted }}>
          Every finished video we've delivered — watch it here, download and share anywhere, any time.
        </p>
      </div>

      {manageMode && (
        <AddPastWork
          companyId={companyId}
          projects={data?.allProjects || []}
          onAdded={() => { showToast('Added to their library ✓'); load(); }}
          onError={showToast}
        />
      )}

      {error && <Card><EmptyState title="Couldn't load your library" body={error} /></Card>}

      {!error && !data && (
        <Card><div style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', padding: 24 }}>Fetching your videos…</div></Card>
      )}

      {data && (data.projects || []).length === 0 && (
        <Card>
          <EmptyState
            icon={<Clapperboard size={34} />}
            title="Your finished videos will live here"
            body={data.unavailable
              ? 'The library is temporarily unavailable — try again shortly.'
              : 'As soon as a video is signed off and delivered, it appears here ready to watch and download.'}
          />
        </Card>
      )}

      {data && (data.projects || []).map((p) => (
        <Card key={p.dealId || 'archive'}>
          <SectionHeading>{p.title}</SectionHeading>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 16 }}>
            {p.files.map((f) => (
              <FileTile
                key={f.fileId || f.videoId || f.itemId}
                dealId={p.dealId}
                file={f}
                onRemove={manageMode && f.kind === 'archive' ? () => removeItem(f) : null}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function FileTile({ dealId, file, onRemove }) {
  const playable = isVideo(file);
  const meta = [file.sizeBytes != null ? fmtBytes(file.sizeBytes) : null, fmtDate(file.createdTime)]
    .filter(Boolean).join(' · ');

  return (
    <div style={{
      border: `1px solid ${BRAND.border}`, borderRadius: 12, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', background: '#fff',
    }}>
      {playable ? (
        // preload="metadata" so a shelf of videos doesn't pull megabytes each on
        // page load — the poster frame and duration are enough until they press play.
        <video
          controls
          preload="metadata"
          playsInline
          controlsList="nodownload"
          src={fileUrl(dealId, file)}
          style={{ width: '100%', aspectRatio: '16 / 9', display: 'block', background: '#000', objectFit: 'contain' }}
        />
      ) : (
        <div style={{ width: '100%', aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', background: '#F2F6F9', color: BRAND.muted }}>
          <Film size={30} />
        </div>
      )}

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.name}>
            {file.name}
          </div>
          {meta && <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>{meta}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
          <a
            className="btn"
            href={fileUrl(dealId, file, { download: true })}
            style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}
          >
            <Download size={15} /> Download
          </a>
          {onRemove && (
            <button className="btn-ghost" onClick={onRemove} title="Remove from the library" style={{ color: '#DC2626', padding: '0 12px' }}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Staff-only (manage mode): stream a past video straight to Blob storage, then
// record it against the org. Uploads bypass the serverless body limit the same
// way the CRM's revision drafts do.
function AddPastWork({ companyId, projects, onAdded, onError }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [dealId, setDealId] = useState('');
  const [progress, setProgress] = useState(null);

  const pick = (f) => {
    if (!f) return;
    setFile(f);
    setTitle((t) => t || f.name.replace(/\.[^.]+$/, ''));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file || progress != null) return;
    setProgress(0);
    try {
      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload(`portal-library/${companyId}/${Date.now()}-${safeName}`, file, {
        access: 'public',
        handleUploadUrl: mediaUrl('library-upload-token'),
        contentType: file.type || 'video/mp4',
        multipart: true, // videos are large: a single-shot PUT fails and retries forever
        onUploadProgress: (ev) => setProgress(Math.round(ev.percentage)),
      });
      await portalApi.post(`library-item?companyId=${encodeURIComponent(companyId)}`, {
        blobUrl: blob.url,
        blobPathname: blob.pathname,
        filename: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
        title: title.trim() || file.name,
        dealId: dealId || null,
      });
      setFile(null); setTitle(''); setDealId('');
      if (fileRef.current) fileRef.current.value = '';
      onAdded();
    } catch (err) {
      onError(err.message || 'Upload failed');
    } finally {
      setProgress(null);
    }
  };

  return (
    <Card style={{ border: '1px solid #F5C26B', background: '#FFFCF5' }}>
      <SectionHeading>Add a past video</SectionHeading>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        Staff only. Drop in work we delivered before the portal existed — the client can watch and download it here alongside everything else.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          onChange={(e) => pick(e.target.files && e.target.files[0])}
          style={{ fontSize: 13 }}
        />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="Title the client will see"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={{ flex: 2, minWidth: 200 }}
          />
          <select className="input" value={dealId} onChange={(e) => setDealId(e.target.value)} style={{ flex: 1, minWidth: 180 }}>
            <option value="">Previous work (no project)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </div>
        {progress != null ? (
          <div>
            <div style={{ height: 8, borderRadius: 999, background: '#E6EDF2', overflow: 'hidden' }}>
              <div style={{ width: `${progress}%`, height: '100%', background: BRAND.blue, transition: 'width 0.2s ease' }} />
            </div>
            <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 6 }}>Uploading… {progress}%</div>
          </div>
        ) : (
          <button className="btn" type="submit" disabled={!file} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {file ? <><Upload size={15} /> Add to library</> : <><PlusCircle size={15} /> Choose a video first</>}
          </button>
        )}
      </form>
    </Card>
  );
}
