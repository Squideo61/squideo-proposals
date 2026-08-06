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
import { PosterPicker } from '../../components/media/PosterPicker.jsx';
import {
  Film, Download, Clapperboard, Upload, Trash2, PlusCircle, Pencil, Layers,
  Image as ImageIcon, ChevronLeft, ChevronRight, PlayCircle,
} from 'lucide-react';

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

const posterUrl = (f) =>
  f.posterVersion ? mediaUrl(`download?scope=poster&id=${encodeURIComponent(f.itemId)}&v=${f.posterVersion}`) : null;

// Re-sort the hand-added videos in every group to match `order` (a list of item
// ids), leaving cuts and Drive files where they are. Used to show a reorder
// straight away rather than waiting on the round trip.
function reorderLocally(data, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return {
    ...data,
    projects: (data.projects || []).map((p) => {
      if (!p.files.some((f) => rank.has(f.itemId))) return p;
      const others = p.files.filter((f) => !rank.has(f.itemId));
      const moved = p.files.filter((f) => rank.has(f.itemId))
        .sort((a, b) => rank.get(a.itemId) - rank.get(b.itemId));
      return { ...p, files: [...others, ...moved] };
    }),
  };
}

export default function Library() {
  const { companyId, manageMode, showToast, isProspect } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    if (!companyId) return;
    portalApi.get(`library?companyId=${encodeURIComponent(companyId)}`)
      .then(setData)
      .catch((err) => setError(err.message));
  };

  useEffect(() => { setData(null); setError(null); load(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Swap a video with its neighbour, then send the group's whole new order.
  // Optimistic: the grid re-sorts immediately and the reload confirms it.
  const move = async (group, file, delta) => {
    const from = group.findIndex((f) => f.itemId === file.itemId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= group.length) return;
    const next = group.slice();
    [next[from], next[to]] = [next[to], next[from]];
    const order = next.map((f) => f.itemId);
    setData((d) => d && reorderLocally(d, order));
    try {
      await portalApi.post(`library-reorder?companyId=${encodeURIComponent(companyId)}`, { ids: order });
      load();
    } catch (err) {
      showToast(err.message);
      load();
    }
  };

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
          {/* "Every finished video we've delivered" is a claim, and for someone
              we have delivered nothing to it reads as a system that has lost
              their work rather than one they haven't used yet. */}
          {isProspect
            ? 'Where your finished videos will live — watch them here, download and share anywhere, any time.'
            : "Every finished video we've delivered — watch it here, download and share anywhere, any time."}
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
          {/* An empty page with nothing to click is where a prospect stops.
              The sample project tour is the strongest thing we can offer here:
              it shows them a delivered video in situ, which is exactly what
              this page is otherwise promising and failing to demonstrate. */}
          <EmptyState
            icon={<Clapperboard size={34} />}
            title={isProspect ? 'Nothing here yet — and that\'s expected' : 'Your finished videos will live here'}
            body={data.unavailable
              ? 'The library is temporarily unavailable — try again shortly.'
              : isProspect
                ? 'This fills up as we sign off each video. Have a look at the sample project to see how a finished one arrives — every cut, every format, downloadable for good.'
                : 'As soon as a video is signed off and delivered, it appears here ready to watch and download.'}
            action={data.unavailable ? null : (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                {isProspect && <a className="btn" href="#/demo">See a sample project</a>}
                <a className={isProspect ? 'btn-ghost' : 'btn'} href="#/brief">Start a brief</a>
              </div>
            )}
          />
        </Card>
      )}

      {data && (data.projects || []).map((p) => {
        // Only hand-added videos carry an order; delivered cuts and Drive files
        // have no row to store one on, so the arrows are scoped to those.
        const ordered = p.files.filter((f) => f.kind === 'archive');
        return (
          <Card key={p.series ? `series:${p.series}` : p.dealId || 'archive'}>
            <SectionHeading>
              {p.series ? <><Layers size={16} style={{ verticalAlign: -3, marginRight: 7, color: BRAND.muted }} />{p.title}</> : p.title}
            </SectionHeading>
            {/* 260px is what fits three across the 1080px content column
                (3 × 260 + 2 × 16 gap = 812), while four would need more than
                the column has — so it lands on three on a laptop and falls to
                two, then one, as the window narrows. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))', gap: 16 }}>
              {p.files.map((f) => (
                <FileTile
                  key={f.fileId || f.videoId || f.itemId}
                  dealId={p.dealId || f.dealId}
                  file={f}
                  manage={manageMode && f.kind === 'archive'}
                  projects={data.allProjects || []}
                  seriesOptions={data.allSeries || []}
                  position={f.kind === 'archive' ? ordered.findIndex((o) => o.itemId === f.itemId) : -1}
                  total={ordered.length}
                  onMove={(delta) => move(ordered, f, delta)}
                  onRemove={() => removeItem(f)}
                  onSaved={load}
                  onError={showToast}
                />
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function FileTile({ dealId, file, manage, projects, seriesOptions, position, total, onMove, onRemove, onSaved, onError }) {
  const { companyId } = usePortal();
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ratio, setRatio] = useState(null); // learnt from the thumbnail's own size
  const playable = isVideo(file);
  const poster = posterUrl(file);
  const meta = [file.sizeBytes != null ? fmtBytes(file.sizeBytes) : null, fmtDate(file.createdTime)]
    .filter(Boolean).join(' · ');

  return (
    <div style={{
      border: `1px solid ${BRAND.border}`, borderRadius: 12, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', background: '#fff',
    }}>
      {picking ? (
        <LibraryPosterPicker
          file={file}
          companyId={companyId}
          onClose={() => setPicking(false)}
          onSaved={() => { setPicking(false); onSaved(); }}
          onError={onError}
        />
      ) : playable && poster && !playing ? (
        // A chosen thumbnail is shown as an IMAGE until they press play, not as
        // the video's poster attribute. With preload="none" the browser never
        // learns the video's shape, so the element keeps its default 2:1 box and
        // pillarboxes a 16:9 poster inside it — the black bars down each side.
        // An <img> sizes to its own dimensions, so there's nothing to letterbox,
        // and the grid costs one small JPEG per tile instead of a video element.
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`Play ${file.name}`}
          style={{
            position: 'relative', display: 'block', width: '100%', padding: 0,
            border: 'none', background: '#000', cursor: 'pointer', lineHeight: 0,
          }}
        >
          <img
            src={poster}
            alt=""
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w && h) setRatio(w / h);
            }}
            style={{ width: '100%', display: 'block' }}
          />
          <span style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            color: '#fff', filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.6))',
          }}>
            <PlayCircle size={54} strokeWidth={1.4} />
          </span>
        </button>
      ) : playable ? (
        // No forced aspect-ratio box: the video sizes to its own shape, so a
        // vertical cut isn't boxed into 16:9. `ratio` is only set once the
        // thumbnail above has told us the shape, which keeps the box steady
        // through the swap to the player.
        <video
          controls
          autoPlay={playing}
          preload="metadata"
          playsInline
          controlsList="nodownload"
          src={fileUrl(dealId, file)}
          style={{ width: '100%', display: 'block', background: '#000', aspectRatio: ratio || undefined }}
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

        {/* Running order within this group. Its own row rather than two more
            icons in the action row, which is already full. */}
        {manage && !editing && !picking && total > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: BRAND.muted }}>
            <button
              className="btn-ghost"
              onClick={() => onMove(-1)}
              disabled={position <= 0}
              title="Move earlier"
              style={{ padding: '2px 7px' }}
            >
              <ChevronLeft size={14} />
            </button>
            <span style={{ minWidth: 62, textAlign: 'center' }}>{position + 1} of {total}</span>
            <button
              className="btn-ghost"
              onClick={() => onMove(1)}
              disabled={position < 0 || position >= total - 1}
              title="Move later"
              style={{ padding: '2px 7px' }}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}

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
          // Wraps rather than overflows: at three-up the tile is narrow and the
          // manage buttons take most of the row.
          <div style={{ display: 'flex', gap: 8, marginTop: 'auto', flexWrap: 'wrap' }}>
            <a
              className="btn"
              href={fileUrl(dealId, file, { download: true })}
              style={{ flex: '1 1 120px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}
            >
              <Download size={15} /> Download
            </a>
            {manage && (
              <>
                {playable && (
                  <button className="btn-ghost" onClick={() => setPicking(true)} title="Choose the thumbnail from a frame of the video" style={{ padding: '0 12px' }}>
                    <ImageIcon size={15} />
                  </button>
                )}
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

// Manage mode: pick the tile's thumbnail from a still in the video. The picker
// itself is shared with Admin → Crash course (src/components/media/PosterPicker.jsx);
// this wrapper supplies the same-origin stream URL and the save call.
//
// The frame is drawn onto a canvas, which browsers refuse to read back from if
// the video came from another origin. The player above streams via a 302 to the
// blob host, so this one asks for the bytes to be relayed through us instead
// (&stream=1) — same origin, clean canvas.
function LibraryPosterPicker({ file, companyId, onClose, onSaved, onError }) {
  return (
    <PosterPicker
      streamSrc={mediaUrl(`download?scope=archive&id=${encodeURIComponent(file.itemId)}&stream=1`)}
      hasPoster={!!file.posterVersion}
      onError={onError}
      onClose={onClose}
      onSave={async (poster) => {
        await portalApi.patch(
          `library-item?companyId=${encodeURIComponent(companyId)}`,
          { id: file.itemId, poster },
        );
        onSaved();
      }}
    />
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

// Identifies a queued file well enough to spot the same one being added twice.
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

// Staff-only (manage mode): stream past videos straight to Blob storage, then
// record them against the org. Uploads bypass the serverless body limit the
// same way the CRM's revision drafts do, and run one at a time — these are
// hundreds of megabytes each, and the Blob SDK already parallelises the parts
// within a single file.
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

  // A back catalogue arrives as a handful of files, often not all in one go —
  // so each drop or selection ADDS to the queue rather than replacing it, and
  // a file already queued is ignored rather than uploaded twice. The title
  // field only makes sense for a single video; the rest take their filename.
  const take = (list) => {
    const picked = Array.from(list || []).filter((f) => f.size > 0);
    if (!picked.length) return;
    setFiles((prev) => {
      const seen = new Set(prev.map(fileKey));
      const next = [...prev, ...picked.filter((f) => !seen.has(fileKey(f)))];
      setTitle(next.length === 1 ? next[0].name.replace(/\.[^.]+$/, '') : '');
      return next;
    });
  };

  const drop = (file) => setFiles((prev) => {
    const next = prev.filter((f) => fileKey(f) !== fileKey(file));
    setTitle(next.length === 1 ? next[0].name.replace(/\.[^.]+$/, '') : '');
    return next;
  });

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
              ? 'Drop them here'
              : files.length
                ? `Add more — ${files.length} video${files.length === 1 ? '' : 's'} queued`
                : 'Drag videos here, or click to choose'}
          </div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 4 }}>
            {files.length
              ? `${fmtBytes(files.reduce((n, f) => n + f.size, 0))} total · they upload one after another`
              : 'MP4 or MOV — select or drop as many as you like, in as many goes as you like'}
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

        {/* The queue, spelled out. A bare count gave no way to see what was
            actually going up, or to drop one file without starting over. */}
        {files.length > 0 && (
          <div style={{ border: `1px solid ${BRAND.border}`, borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
            {files.map((f, i) => {
              const state = !busy ? 'queued'
                : i < progress.index - 1 ? 'done'
                  : i === progress.index - 1 ? 'uploading' : 'waiting';
              return (
                <div key={fileKey(f)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', fontSize: 12.5,
                  borderTop: i ? `1px solid ${BRAND.border}` : 'none',
                  background: state === 'uploading' ? '#F5FBFE' : undefined,
                }}>
                  <span style={{ color: BRAND.muted, minWidth: 16, textAlign: 'right' }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</div>
                    <div style={{ fontSize: 11, color: BRAND.muted }}>{fmtBytes(f.size)}</div>
                  </div>
                  {state === 'done' && <span style={{ color: '#16A34A', fontSize: 11.5, fontWeight: 700 }}>Added ✓</span>}
                  {state === 'uploading' && <span style={{ color: BRAND.blue, fontSize: 11.5, fontWeight: 700 }}>{progress.percent}%</span>}
                  {state === 'waiting' && <span style={{ color: BRAND.muted, fontSize: 11.5 }}>Waiting</span>}
                  {state === 'queued' && (
                    <button type="button" className="btn-ghost" onClick={() => drop(f)} title="Remove from the queue" style={{ color: '#DC2626', padding: '2px 8px' }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>
        )}

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
              {progress.total > 1 ? `Uploading ${progress.index} of ${progress.total} — ` : 'Uploading '}
              {files[progress.index - 1]?.name || ''} {progress.percent}%
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
              : <><PlusCircle size={15} /> Choose your videos first</>}
          </button>
        )}
      </form>
    </Card>
  );
}
