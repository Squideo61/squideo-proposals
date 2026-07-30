// The video library: everything we've delivered this client — the approved cut
// from each project, finished renders from its Drive "Signed Off" folder, and
// past work staff have added by hand. Each video plays right here; every file
// has its own download button.
//
// Videos are grouped by project, except that a hand-added video with a SERIES
// name groups under that instead — a run of videos the client thinks of as one
// set rarely maps to one deal.
//
// In manage mode (staff inside the client's portal) an upload panel appears at
// the top, and each hand-added video can be retitled, moved between series or
// removed.
import React, { useEffect, useRef, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi, mediaUrl } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, fmtBytes, fmtDate } from '../components.jsx';
import { Film, Download, Clapperboard, Upload, Trash2, PlusCircle, Pencil, Layers } from 'lucide-react';

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
          series={data?.allSeries || []}
          onDone={(added, error) => {
            if (error) showToast(error);
            else if (added) showToast(added > 1 ? `${added} videos added to their library ✓` : 'Added to their library ✓');
            if (added) load();
          }}
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
        <Card key={p.series ? `series:${p.series}` : p.dealId || 'archive'}>
          <SectionHeading>
            {p.series ? <><Layers size={16} style={{ verticalAlign: -3, marginRight: 7, color: BRAND.muted }} />{p.title}</> : p.title}
          </SectionHeading>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 16 }}>
            {p.files.map((f) => (
              <FileTile
                key={f.fileId || f.videoId || f.itemId}
                dealId={p.dealId || f.dealId}
                file={f}
                manage={manageMode && f.kind === 'archive'}
                projects={data.allProjects || []}
                seriesOptions={data.allSeries || []}
                onRemove={() => removeItem(f)}
                onSaved={load}
                onError={showToast}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function FileTile({ dealId, file, manage, projects, seriesOptions, onRemove, onSaved, onError }) {
  const { companyId } = usePortal();
  const [editing, setEditing] = useState(false);
  const playable = isVideo(file);
  const meta = [file.sizeBytes != null ? fmtBytes(file.sizeBytes) : null, fmtDate(file.createdTime)]
    .filter(Boolean).join(' · ');

  return (
    <div style={{
      border: `1px solid ${BRAND.border}`, borderRadius: 12, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', background: '#fff',
    }}>
      {playable ? (
        // No forced aspect-ratio box: the video sizes to its own shape, so there
        // are never letterbox bars (a fractional column width used to leave a
        // black sliver down one edge) and a vertical cut isn't boxed into 16:9.
        // preload="metadata" keeps a shelf of videos from pulling megabytes each
        // on load — the poster frame and duration are enough until they press play.
        <video
          controls
          preload="metadata"
          playsInline
          controlsList="nodownload"
          src={fileUrl(dealId, file)}
          style={{ width: '100%', display: 'block', background: '#000' }}
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

        {editing ? (
          <EditItem
            companyId={companyId}
            file={file}
            projects={projects}
            seriesOptions={seriesOptions}
            onClose={() => setEditing(false)}
            onSaved={() => { setEditing(false); onSaved(); }}
            onError={onError}
          />
        ) : (
          <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
            <a
              className="btn"
              href={fileUrl(dealId, file, { download: true })}
              style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}
            >
              <Download size={15} /> Download
            </a>
            {manage && (
              <>
                <button className="btn-ghost" onClick={() => setEditing(true)} title="Rename or move to a series" style={{ padding: '0 12px' }}>
                  <Pencil size={15} />
                </button>
                <button className="btn-ghost" onClick={onRemove} title="Remove from the library" style={{ color: '#DC2626', padding: '0 12px' }}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Manage mode: retitle a library video or move it into a series, without
// having to delete and re-upload it.
function EditItem({ companyId, file, projects, seriesOptions, onClose, onSaved, onError }) {
  const [title, setTitle] = useState(file.name || '');
  const [series, setSeries] = useState(file.series || '');
  const [dealId, setDealId] = useState(file.dealId || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await portalApi.patch(`library-item?companyId=${encodeURIComponent(companyId)}`, {
        id: file.itemId, title, series, dealId: dealId || null,
      });
      onSaved();
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }}>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={{ fontSize: 13 }} />
      <SeriesPicker value={series} onChange={setSeries} options={seriesOptions} />
      <select className="input" value={dealId} onChange={(e) => setDealId(e.target.value)} style={{ fontSize: 13 }}>
        <option value="">No project</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
      </select>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={save} disabled={busy} style={{ flex: 1 }}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn-ghost" onClick={onClose} disabled={busy} style={{ padding: '0 12px' }}>Cancel</button>
      </div>
    </div>
  );
}

// Pick one of THIS client's existing series, or name a new one. A real <select>
// rather than a text box with a datalist: with a datalist there's no way to tell
// a stored series from a suggestion, and retyping a name with different
// capitalisation silently splits the group in two.
const NEW_SERIES = '__new__';

function SeriesPicker({ value, onChange, options }) {
  const [creating, setCreating] = useState(false);
  // A value that isn't (yet) one of the saved series means we're mid-creation.
  const typing = creating || (!!value && !options.includes(value));

  const select = (v) => {
    if (v === NEW_SERIES) { setCreating(true); onChange(''); }
    else { setCreating(false); onChange(v); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <select
        className="input"
        value={typing ? NEW_SERIES : value}
        onChange={(e) => select(e.target.value)}
        style={{ fontSize: 13 }}
      >
        <option value="">No series</option>
        {options.map((s) => <option key={s} value={s}>{s}</option>)}
        <option value={NEW_SERIES}>+ New series…</option>
      </select>
      {typing && (
        <input
          className="input"
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Name the series — e.g. Sexual Difficulties Video Series"
          style={{ fontSize: 13 }}
        />
      )}
    </div>
  );
}

// Staff-only (manage mode): stream a past video straight to Blob storage, then
// record it against the org. Uploads bypass the serverless body limit the same
// way the CRM's revision drafts do.
function AddPastWork({ companyId, projects, series: seriesOptions, onDone }) {
  const fileRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [title, setTitle] = useState('');
  const [series, setSeries] = useState('');
  const [dealId, setDealId] = useState('');
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState(null); // { index, total, percent }
  const [stalled, setStalled] = useState(false);

  // The Blob SDK retries a failed request 10 times with backoff, so a blocked
  // or flaky connection sits at 0% for minutes before it finally throws. Say
  // something rather than leaving a dead progress bar.
  useEffect(() => {
    setStalled(false);
    if (!progress || progress.percent > 0) return undefined;
    const t = window.setTimeout(() => setStalled(true), 25_000);
    return () => window.clearTimeout(t);
  }, [progress?.index, progress?.percent > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // A back catalogue arrives as a handful of files at once, so a multi-drop
  // uploads the lot rather than silently keeping the first. The title field
  // only makes sense for a single video — the rest take their filename.
  const take = (list) => {
    const picked = Array.from(list || []).filter((f) => f.size > 0);
    if (!picked.length) return;
    setFiles(picked);
    setTitle(picked.length === 1 ? picked[0].name.replace(/\.[^.]+$/, '') : '');
  };

  const dropProps = {
    onDragOver: (e) => { e.preventDefault(); setDrag(true); },
    onDragEnter: (e) => { e.preventDefault(); setDrag(true); },
    onDragLeave: (e) => { e.preventDefault(); setDrag(false); },
    onDrop: (e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer?.files); },
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!files.length || progress != null) return;
    const { upload } = await import('@vercel/blob/client');
    let added = 0;
    try {
      for (const [i, file] of files.entries()) {
        setProgress({ index: i + 1, total: files.length, percent: 0 });
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        // eslint-disable-next-line no-await-in-loop
        const blob = await upload(`portal-library/${companyId}/${Date.now()}-${safeName}`, file, {
          access: 'public',
          handleUploadUrl: mediaUrl('library-upload-token'),
          contentType: file.type || 'video/mp4',
          multipart: true, // videos are large: a single-shot PUT fails and retries forever
          onUploadProgress: (ev) => setProgress((p) => (p ? { ...p, percent: Math.round(ev.percentage) } : p)),
        });
        // eslint-disable-next-line no-await-in-loop
        await portalApi.post(`library-item?companyId=${encodeURIComponent(companyId)}`, {
          blobUrl: blob.url,
          blobPathname: blob.pathname,
          filename: file.name,
          mimeType: file.type || null,
          sizeBytes: file.size,
          title: (files.length === 1 && title.trim()) || file.name.replace(/\.[^.]+$/, ''),
          series: series.trim() || null,
          dealId: dealId || null,
        });
        added += 1;
      }
      // The series is deliberately kept: a back catalogue usually goes up in
      // batches that belong to the same set.
      setFiles([]); setTitle(''); setDealId('');
      if (fileRef.current) fileRef.current.value = '';
      onDone(added, null);
    } catch (err) {
      // Whatever landed before the failure is already in their library — say so
      // rather than implying the whole batch was lost, and still refresh so the
      // ones that made it show up.
      onDone(added, added
        ? `${added} added, then it failed: ${err.message || 'Upload failed'}`
        : (err.message || 'Upload failed'));
    } finally {
      setProgress(null);
    }
  };

  const busy = progress != null;
  return (
    <Card style={{ border: '1px solid #F5C26B', background: '#FFFCF5' }}>
      <SectionHeading>Add a past video</SectionHeading>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        Staff only. Drop in work we delivered before the portal existed — the client can watch and download it here alongside everything else.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          {...dropProps}
          onClick={() => !busy && fileRef.current?.click()}
          style={{
            border: `2px dashed ${drag ? BRAND.blue : '#E3D3AE'}`,
            background: drag ? BRAND.blue + '0d' : '#fff',
            borderRadius: 12, padding: '22px 16px', textAlign: 'center',
            cursor: busy ? 'default' : 'pointer', transition: 'all 0.15s ease',
          }}
        >
          <Upload size={20} color={drag ? BRAND.blue : BRAND.muted} />
          <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginTop: 8 }}>
            {drag
              ? 'Drop the videos here'
              : files.length === 1
                ? files[0].name
                : files.length > 1
                  ? `${files.length} videos ready`
                  : 'Drag videos here, or click to choose'}
          </div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 4 }}>
            {files.length
              ? `${fmtBytes(files.reduce((n, f) => n + f.size, 0))} total · drop again to replace`
              : 'MP4 or MOV — drop several at once for a back catalogue'}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            multiple
            hidden
            onChange={(e) => { take(e.target.files); e.target.value = ''; }}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {files.length > 1 ? (
            <div style={{ flex: 2, minWidth: 200, fontSize: 12.5, color: BRAND.muted, alignSelf: 'center' }}>
              Each video takes its filename as its title — rename them on the tile afterwards if you'd rather.
            </div>
          ) : (
            <input
              className="input"
              placeholder="Title the client will see"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ flex: 2, minWidth: 200 }}
            />
          )}
          <select className="input" value={dealId} onChange={(e) => setDealId(e.target.value)} style={{ flex: 1, minWidth: 180 }}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </div>

        {/* A series groups a run of videos under its own heading in the library —
            it takes precedence over the project, which is what makes a set read
            as a set. Left blank, the video files under its project or
            "Previous work". */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <SeriesPicker value={series} onChange={setSeries} options={seriesOptions} />
          </div>
          <div style={{ flex: 1, minWidth: 200, fontSize: 11.5, color: BRAND.muted, paddingTop: 9 }}>
            {seriesOptions.length
              ? 'Pick one of this client’s series, or add a new one — each gets its own group in the library.'
              : 'A series gives a run of videos its own group in the library.'}
          </div>
        </div>

        {busy ? (
          <div>
            <div style={{ height: 8, borderRadius: 999, background: '#E6EDF2', overflow: 'hidden' }}>
              <div style={{ width: `${progress.percent}%`, height: '100%', background: BRAND.blue, transition: 'width 0.2s ease' }} />
            </div>
            <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 6 }}>
              {progress.total > 1 ? `Uploading ${progress.index} of ${progress.total}… ` : 'Uploading… '}{progress.percent}%
            </div>
            {stalled && (
              <div style={{ fontSize: 12, color: '#B45309', marginTop: 4 }}>
                Still trying to start — we're retrying. If it doesn't move, check the connection and try again.
              </div>
            )}
          </div>
        ) : (
          <button className="btn" type="submit" disabled={!files.length} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {files.length
              ? <><Upload size={15} /> Add {files.length > 1 ? `${files.length} videos` : ''} to library</>
              : <><PlusCircle size={15} /> Choose a video first</>}
          </button>
        )}
      </form>
    </Card>
  );
}
