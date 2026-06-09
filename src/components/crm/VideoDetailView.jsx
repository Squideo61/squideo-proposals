import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Film, FolderOpen, Send, ExternalLink, Trash2, FileText, Upload, CheckCircle2, Circle, ListChecks, ChevronDown, ChevronRight, Link2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile, formatRelativeTime } from '../../utils.js';
import {
  PRODUCTION_PHASES, PHASE_BY_ID, PAYMENT_OPTION_LABEL,
  VIDEO_MILESTONES, STAGE_LABEL,
} from '../../lib/productionStages.js';
import { VideoProgressBar } from './ProductionProgressBar.jsx';
import { DealConversation } from './DealConversation.jsx';
import { AssigneePicker } from './TaskFormModal.jsx';
import { PdfPage } from '../storyboard/PdfPage.jsx';

const sectionCard = {
  background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20, marginTop: 18,
};
const approvedChip = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px',
  borderRadius: 999, background: '#16A34A', color: '#fff', fontSize: 11, fontWeight: 700,
};

const ctrl = {
  width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border,
  fontSize: 13, color: BRAND.ink, background: 'white', boxSizing: 'border-box',
};
const labelStyle = { fontSize: 12, color: BRAND.muted, marginBottom: 4, display: 'block' };

// A single video's page: its board position (phase + stage), its Monday-style
// columns, status, and the client review hand-off. Opened from the production
// board and from the project page.
export function VideoDetailView({ videoId, onBack, onOpenProject, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();

  useEffect(() => { if (videoId) actions.loadVideo(videoId); }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  const video = state.videoDetail?.[videoId];

  if (!video) {
    return (
      <div style={{ padding: 32 }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <p style={{ marginTop: 24, color: BRAND.muted }}>Loading video…</p>
      </div>
    );
  }

  const phase = PHASE_BY_ID[video.productionPhase] || PRODUCTION_PHASES[0];
  const stageLabel = STAGE_LABEL[phase.id]?.[video.productionStage] || video.productionStage || phase.stages[0]?.label;
  const update = (fields) => actions.updateVideo(videoId, fields).catch(() => {});


  const sendForReview = () => {
    actions.sendVideoForReview(video.dealId, videoId)
      .then((resp) => {
        if (resp?.reviewUrl) navigator.clipboard?.writeText(resp.reviewUrl).catch(() => {});
        showMsg(video.revisionVideoId ? 'Review link copied' : 'Sent for review — link copied');
      })
      .catch(e => showMsg(e.message || 'Could not send for review'));
  };
  const sendStoryboard = () => {
    actions.sendStoryboardForReview(video.dealId, videoId)
      .then((resp) => {
        if (resp?.reviewUrl) navigator.clipboard?.writeText(resp.reviewUrl).catch(() => {});
        showMsg(video.storyboardId ? 'Storyboard link copied' : 'Storyboard review created — link copied');
      })
      .catch(e => showMsg(e.message || 'Could not create storyboard review'));
  };
  const remove = () => {
    if (!window.confirm(`Delete "${video.title}"? This removes the video from its project.`)) return;
    actions.deleteProjectVideo(video.dealId, videoId).then(() => onBack());
  };

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Production</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onOpenProject && video.dealId && (
            <button onClick={() => onOpenProject(video.dealId)} className="btn-ghost"><FolderOpen size={14} /> Open project</button>
          )}
          <button onClick={sendStoryboard} className="btn-ghost">
            {video.storyboardId ? <><ExternalLink size={14} /> Storyboard link</> : <><Send size={14} /> Storyboard review</>}
          </button>
          <button onClick={sendForReview} className="btn-ghost">
            {video.revisionVideoId ? <><ExternalLink size={14} /> Review link</> : <><Send size={14} /> Send for review</>}
          </button>
          <button onClick={remove} className="btn-ghost is-danger"><Trash2 size={14} /> Delete</button>
        </div>
      </header>

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, alignItems: 'flex-start' }}>
        {/* Left column: details + script + milestones */}
        <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : undefined }}>
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Film size={18} color={phase.color} />
          <InlineText
            value={video.title}
            onSave={(v) => update({ title: v || video.title })}
            style={{ ...ctrl, fontSize: 20, fontWeight: 700, border: '1px solid transparent', padding: '4px 6px' }}
          />
        </div>
        {(video.projectTitle || video.companyName) && (
          <button onClick={() => onOpenProject && video.dealId && onOpenProject(video.dealId)}
            style={{ background: 'none', border: 'none', padding: '0 6px 0 32px', cursor: onOpenProject ? 'pointer' : 'default', color: BRAND.muted, fontSize: 13, marginBottom: 16 }}>
            {[video.projectTitle, video.companyName].filter(Boolean).join(' · ')}
          </button>
        )}

        {/* Production progress — detailed stage bar (click a step to move the
            video there, across phases too) with the exact board stage beneath.
            Replaces the old manual Status dropdown. */}
        <div style={{ marginTop: 4, marginBottom: 16 }}>
          <VideoProgressBar
            phaseId={phase.id}
            stageId={video.productionStage}
            revisionRound={video.revisionRound}
            onMove={(p, s) => actions.moveVideoStage(videoId, p, s)}
          />
          <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 6 }}>Stage: {stageLabel}</div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 14, marginTop: 12 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Producers</label>
            <AssigneePicker
              users={Object.entries(state.users || {}).map(([email, u]) => ({ email, ...u }))}
              selected={video.producerEmails || (video.producerEmail ? [video.producerEmail] : [])}
              onToggle={(email) => {
                const set = new Set(video.producerEmails || (video.producerEmail ? [video.producerEmail] : []));
                set.has(email) ? set.delete(email) : set.add(email);
                update({ producerEmails: Array.from(set) });
              }}
              emptyLabel="No producers assigned"
            />
          </div>
          <div>
            <label style={labelStyle}>Payment</label>
            <div style={{ ...ctrl, background: '#F8FAFC', display: 'flex', alignItems: 'center', minHeight: 36,
              color: video.paymentOption ? BRAND.ink : BRAND.muted }}
              title="Pulled from the signed proposal">
              {PAYMENT_OPTION_LABEL[video.paymentOption] || (video.paymentOption || 'No signed proposal')}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Video length</label>
            <InlineText value={video.videoLength} placeholder="e.g. 90s, 1.5m, 606w" onSave={(v) => update({ videoLength: v })} />
          </div>
          <div>
            <label style={labelStyle}>Delivery deadline</label>
            <input type="date" style={ctrl} value={(video.deliveryDeadline || '').slice(0, 10)}
              onChange={(e) => update({ deliveryDeadline: e.target.value || null })} />
          </div>
          <div>
            <label style={labelStyle}>Text-direction deadline</label>
            <input type="date" style={ctrl} value={(video.textDirectionDeadline || '').slice(0, 10)}
              onChange={(e) => update({ textDirectionDeadline: e.target.value || null })} />
          </div>
        </div>
      </div>

          <MilestonesCard video={video} videoId={videoId} />
          {/* Emails + Comments sit side-by-side, full width, growing with their
              content — so the team can read a long comment thread without the
              cramped scroll the old right-column panel forced. */}
          {video.dealId && (
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, alignItems: 'start' }}>
              <DealConversation dealId={video.dealId} isMobile={isMobile} sections={['emails']} />
              <DealConversation dealId={video.dealId} isMobile={isMobile} sections={['comments']} />
            </div>
          )}
        </div>

        {/* Right column: stage-locked preview + activity/comments, full height */}
        <div style={{
          width: isMobile ? '100%' : 440, flexShrink: 0, alignSelf: 'flex-start',
          position: isMobile ? 'static' : 'sticky', top: isMobile ? undefined : 72,
          height: isMobile ? 'auto' : 'calc(100vh - 96px)',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          <PreviewPane preview={video.preview} revisionStatus={video.revisionStatus} sentForReview={!!video.revisionVideoId} isMobile={isMobile} />
          {(video.revisionVideoId || video.revisionStatus) && (
            <RevisionStatusCard revisionStatus={video.revisionStatus} sentForReview={!!video.revisionVideoId}
              dealId={video.dealId} videoId={videoId} />
          )}
          {!video.revisionVideoId && (video.dealRevisionVideos || []).length > 0 && (
            <LinkRevisionCard dealId={video.dealId} videoId={videoId} candidates={video.dealRevisionVideos} />
          )}
          {(video.storyboardId || video.storyboardStatus) && (
            <StoryboardStatusCard storyboardStatus={video.storyboardStatus} linked={!!video.storyboardId}
              dealId={video.dealId} videoId={videoId} />
          )}
          {!video.storyboardId && (video.dealStoryboards || []).length > 0 && (
            <LinkStoryboardCard dealId={video.dealId} videoId={videoId} candidates={video.dealStoryboards} />
          )}
          <div style={{ flex: isMobile ? 'none' : 1, minHeight: 0, overflowY: isMobile ? 'visible' : 'auto' }}>
            {video.dealId && <DealConversation dealId={video.dealId} isMobile={isMobile} sections={['activity']} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// Stage-locked preview of the current deliverable: a script doc in the script
// stages, a storyboard PDF while storyboarding, then the latest draft video.
// `preview.current` (server-computed from the board stage) picks which asset.
const PREVIEW_META = {
  script:     { label: 'Script', icon: FileText, empty: 'No script uploaded yet.' },
  storyboard: { label: 'Storyboard', icon: FileText, empty: 'No storyboard linked yet — use “Storyboard review”, then upload a draft PDF.' },
  video:      { label: 'Draft video', icon: Film, empty: 'No draft video yet — use “Send for review”, then upload a draft.' },
};

// Turn a Google Drive/Docs link into an embeddable preview URL, or null if it
// isn't a recognised Google link (caller then shows a plain "View" button).
function googleEmbedUrl(url) {
  if (!url) return null;
  if (url.includes('drive.google.com')) return url.replace('/view', '/preview');
  // docs.google.com/{document,spreadsheets,presentation}/d/<id>/… → …/preview
  const m = url.match(/^(https:\/\/docs\.google\.com\/[a-z]+\/d\/[^/?#]+)/i);
  if (m) return m[1] + '/preview';
  return null;
}

function PreviewPane({ preview, revisionStatus, sentForReview, isMobile }) {
  const p = preview || {};
  const kind = PREVIEW_META[p.current] ? p.current : 'script';
  const asset = kind === 'script' ? p.script : kind === 'storyboard' ? p.storyboard : p.video;
  const meta = PREVIEW_META[kind];
  const Icon = meta.icon;
  const url = asset?.url || null;
  // Embeddable Google preview URL for a script doc — covers Drive files
  // (…/view → …/preview) and Google Docs/Sheets/Slides (…/edit → …/preview).
  const scriptEmbedUrl = kind === 'script' ? googleEmbedUrl(url) : null;
  // Label the draft (e.g. "Draft 2 preview") + show when it was uploaded, so a
  // freshly-arrived revised cut is visible at a glance rather than silently
  // replacing the existing preview asset.
  const showDraftMeta = kind === 'video' && revisionStatus;
  const draftLabel = showDraftMeta && revisionStatus.latestVersionNumber != null
    ? (revisionStatus.latestVersionLabel || ('Draft ' + revisionStatus.latestVersionNumber))
    : meta.label;
  const headerTitle = showDraftMeta && revisionStatus.latestVersionNumber != null
    ? draftLabel + ' preview'
    : meta.label + ' preview';

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', height: isMobile ? 260 : 'clamp(220px, 30vh, 380px)', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid ' + BRAND.border, flexShrink: 0 }}>
        <Icon size={15} color={BRAND.blue} />
        <strong style={{ fontSize: 13, color: BRAND.ink }}>{headerTitle}</strong>
        {showDraftMeta && revisionStatus.latestVersionAt && (
          <span style={{ fontSize: 11, color: BRAND.muted }}>· uploaded {formatRelativeTime(revisionStatus.latestVersionAt)}</span>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer"
            style={{ marginLeft: 'auto', fontSize: 12, color: BRAND.blue, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ExternalLink size={12} /> Open
          </a>
        )}
      </div>
      {kind === 'video' && (revisionStatus || sentForReview) && (
        <RevisionStatusRow revisionStatus={revisionStatus} sentForReview={sentForReview} />
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: kind === 'storyboard' ? '#0B1B26' : '#fff',
        overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!url ? (
          <div style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', padding: 18, lineHeight: 1.5 }}>{meta.empty}</div>
        ) : kind === 'script' ? (
          scriptEmbedUrl ? (
            <iframe src={scriptEmbedUrl} title="Script preview"
              style={{ width: '100%', height: '100%', border: 0 }} />
          ) : (
            <a href={url} target="_blank" rel="noreferrer" className="btn"><ExternalLink size={14} /> View script</a>
          )
        ) : kind === 'storyboard' ? (
          <div style={{ width: '100%', padding: 10 }}>
            <PdfPage url={url} pageNumber={1} />
          </div>
        ) : (
          <video src={url} controls style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        )}
      </div>
    </div>
  );
}

// Mirror of RevisionStatusCard for the storyboard side. Same shape, just
// pointed at storyboardStatus + the storyboard link/unlink actions.
function StoryboardStatusCard({ storyboardStatus, linked, dealId, videoId }) {
  const { actions, showMsg } = useStore();
  const [unlinking, setUnlinking] = useState(false);
  const unlink = () => {
    if (!window.confirm('Unlink this video from its storyboard? The drafts and comments will still exist in the Storyboards section.')) return;
    setUnlinking(true);
    actions.unlinkStoryboard(dealId, videoId)
      .then(() => showMsg('Unlinked from storyboard'))
      .catch(err => showMsg(err.message || 'Could not unlink'))
      .finally(() => setUnlinking(false));
  };
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid ' + BRAND.border }}>
        <FileText size={15} color={BRAND.blue} />
        <strong style={{ fontSize: 13, color: BRAND.ink }}>Storyboard review</strong>
        <button onClick={unlink} disabled={unlinking}
          title="Unlink this video from the storyboard (drafts + comments stay in the Storyboards section)"
          style={{ marginLeft: 'auto', background: '#F1F5F9', border: '1px solid ' + BRAND.border,
            borderRadius: 6, cursor: unlinking ? 'default' : 'pointer',
            color: BRAND.muted, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>
          {unlinking ? 'Unlinking…' : 'Unlink'}
        </button>
      </div>
      <RevisionStatusRow revisionStatus={storyboardStatus} sentForReview={linked} />
    </div>
  );
}

// Mirror of LinkRevisionCard for the storyboard side.
function LinkStoryboardCard({ dealId, videoId, candidates }) {
  const { actions, showMsg } = useStore();
  const [pick, setPick] = useState(candidates[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const link = () => {
    if (!pick || busy) return;
    setBusy(true);
    actions.linkStoryboard(dealId, videoId, pick)
      .then(() => showMsg('Linked — storyboard activity will appear here.'))
      .catch(err => showMsg(err.message || 'Could not link storyboard'))
      .finally(() => setBusy(false));
  };
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid ' + BRAND.border }}>
        <FileText size={15} color={BRAND.blue} />
        <strong style={{ fontSize: 13, color: BRAND.ink }}>Link to a storyboard</strong>
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: BRAND.muted }}>
          This deal has storyboards in the Storyboards section but this video isn't linked to one yet.
        </div>
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={ctrl}>
          {candidates.map(c => (
            <option key={c.id} value={c.id}>
              {c.title}{c.versionCount > 0 ? ` (${c.versionCount} draft${c.versionCount === 1 ? '' : 's'})` : ''}
            </option>
          ))}
        </select>
        <button onClick={link} disabled={!pick || busy} className="btn" style={{ alignSelf: 'flex-start' }}>
          {busy ? 'Linking…' : 'Link this video'}
        </button>
      </div>
    </div>
  );
}

// Shown when the deal has a revision project but the title-based auto-link
// couldn't match this specific project_video. Lets the producer pick which
// revision_video to connect, so the status card then takes over.
function LinkRevisionCard({ dealId, videoId, candidates }) {
  const { actions, showMsg } = useStore();
  const [pick, setPick] = useState(candidates[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const link = () => {
    if (!pick || busy) return;
    setBusy(true);
    actions.linkRevisionVideo(dealId, videoId, pick)
      .then(() => showMsg('Linked — revision activity will appear here.'))
      .catch(err => showMsg(err.message || 'Could not link revision'))
      .finally(() => setBusy(false));
  };
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid ' + BRAND.border }}>
        <Film size={15} color={BRAND.blue} />
        <strong style={{ fontSize: 13, color: BRAND.ink }}>Link to a revision</strong>
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: BRAND.muted }}>
          This deal has revisions in the Revisions section but this video isn't linked to one yet.
        </div>
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={ctrl}>
          {candidates.map(c => (
            <option key={c.id} value={c.id}>
              {c.title}{c.versionCount > 0 ? ` (${c.versionCount} draft${c.versionCount === 1 ? '' : 's'})` : ''}
            </option>
          ))}
        </select>
        <button onClick={link} disabled={!pick || busy} className="btn" style={{ alignSelf: 'flex-start' }}>
          {busy ? 'Linking…' : 'Link this video'}
        </button>
      </div>
    </div>
  );
}

// Standalone card under the PreviewPane that surfaces the current revision
// round even when the production stage hasn't reached Video yet (the
// PreviewPane might be showing the script/storyboard, but the producer still
// needs to know a revised cut has landed).
function RevisionStatusCard({ revisionStatus, sentForReview, dealId, videoId }) {
  const { actions, showMsg } = useStore();
  const [unlinking, setUnlinking] = useState(false);
  const unlink = () => {
    if (!window.confirm('Unlink this video from its revision? The drafts and comments will still exist in the Revisions section.')) return;
    setUnlinking(true);
    actions.unlinkRevisionVideo(dealId, videoId)
      .then(() => showMsg('Unlinked from revision'))
      .catch(err => showMsg(err.message || 'Could not unlink'))
      .finally(() => setUnlinking(false));
  };
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid ' + BRAND.border }}>
        <Film size={15} color={BRAND.blue} />
        <strong style={{ fontSize: 13, color: BRAND.ink }}>Client review</strong>
        <button onClick={unlink} disabled={unlinking}
          title="Unlink this video from the revision (drafts + comments stay in the Revisions section)"
          style={{ marginLeft: 'auto', background: '#F1F5F9', border: '1px solid ' + BRAND.border,
            borderRadius: 6, cursor: unlinking ? 'default' : 'pointer',
            color: BRAND.muted, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>
          {unlinking ? 'Unlinking…' : 'Unlink'}
        </button>
      </div>
      <RevisionStatusRow revisionStatus={revisionStatus} sentForReview={sentForReview} />
    </div>
  );
}

// Slim status strip under the draft-video preview header summarising the
// current revision round: sent state, comments, feedback submitted, approval.
// Always renders when the video is linked to the Revisions section, even
// before the first draft is uploaded (so the producer can see the link is
// live but awaiting a cut).
function RevisionStatusRow({ revisionStatus, sentForReview }) {
  const rs = revisionStatus || {};
  const hasDraft = rs.latestVersionNumber != null;
  const pills = [];
  if (sentForReview && !hasDraft) {
    pills.push({ text: 'Sent · awaiting first draft', color: BRAND.muted });
  } else if (sentForReview) {
    pills.push({ text: 'Sent for review', color: BRAND.blue });
  }
  if (hasDraft && rs.versionCount > 1) {
    pills.push({ text: rs.versionCount + ' drafts', color: BRAND.muted });
  }
  if (hasDraft && rs.commentCount > 0) {
    pills.push({
      text: (rs.openCommentCount > 0
        ? rs.openCommentCount + ' open / ' + rs.commentCount + ' comments'
        : rs.commentCount + ' comments · all addressed'),
      color: rs.openCommentCount > 0 ? '#C2410C' : '#16A34A',
    });
  }
  if (rs.feedbackSubmittedAt && !rs.approvedAt) {
    pills.push({ text: 'Client sent feedback', color: '#7C3AED' });
  }
  if (rs.approvedAt) {
    pills.push({ text: 'Approved' + (rs.approvedBy ? ' by ' + rs.approvedBy : ''), color: '#16A34A' });
  }
  if (!pills.length) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '6px 12px', background: '#F8FAFC',
      borderBottom: '1px solid ' + BRAND.border, flexShrink: 0,
    }}>
      {pills.map((p, i) => (
        <span key={i} style={{ fontSize: 11, fontWeight: 700, color: p.color }}>
          {i > 0 && <span style={{ color: BRAND.muted, fontWeight: 400, marginRight: 8 }}>·</span>}
          {p.text}
        </span>
      ))}
    </div>
  );
}

// Resolve an actor email to a display name from the loaded users.
function useUserName() {
  const { state } = useStore();
  return (email) => (email && state.users?.[email]?.name) || email || 'Someone';
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

// Per-milestone uploader config (typed accept + icon + dropzone hint).
const MILESTONE_UI = {
  // Script & Text Direction is one milestone — accepts the script doc plus any
  // reference imagery / text-direction PDFs (they're sent to the client together).
  script:     { icon: FileText, accept: '.pdf,.doc,.docx,.txt,.rtf,application/pdf,image/*', hint: 'Drop the script & text direction here (PDF, DOC, images…)' },
  storyboard: { icon: FileText, accept: 'application/pdf',                                   hint: 'Drop the storyboard PDF here, or click to upload' },
  video:      { icon: Film,     accept: 'video/*',                                          hint: 'Drop the draft video here, or click to upload' },
};

const isPdf   = (a) => (a?.mimeType || '').includes('pdf') || /\.pdf$/i.test(a?.filename || '');
const isImage = (a) => (a?.mimeType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(a?.filename || '');
const isVideo = (a) => (a?.mimeType || '').startsWith('video/') || /\.(mp4|mov|webm|m4v|avi)$/i.test(a?.filename || '');

// Inline preview of a milestone's latest uploaded asset, typed by file kind.
function MilestonePreview({ asset }) {
  if (!asset?.url) return null;
  const box = { marginTop: 10, border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden', maxWidth: 520 };
  if (isVideo(asset)) return <div style={box}><video src={asset.url} controls style={{ width: '100%', display: 'block', background: '#000' }} /></div>;
  if (isImage(asset)) return <div style={box}><img src={asset.url} alt={asset.filename} style={{ width: '100%', display: 'block' }} /></div>;
  if (isPdf(asset))   return <div style={{ ...box, background: '#0B1B26', padding: 8 }}><PdfPage url={asset.url} pageNumber={1} /></div>;
  const gembed = googleEmbedUrl(asset.url);
  if (gembed) return <div style={{ ...box, height: 360 }}><iframe src={gembed} title={asset.filename} style={{ width: '100%', height: '100%', border: 0 }} /></div>;
  return null; // other documents: the file list carries a View link
}

// Milestones: Script & Text Direction → Storyboard → Video. Each is an
// expandable panel where producers upload typed content, preview it, and
// approve — approving advances the card forward on the board.
function MilestonesCard({ video, videoId }) {
  const approvedMap = Object.fromEntries((video.milestones || []).map(m => [m.id, m]));
  const assetsByMilestone = video.milestoneAssets || {};
  const current = video.preview?.current;
  const [overrides, setOverrides] = useState({});
  const isOpen = (id) => (id in overrides ? overrides[id] : id === current);
  const toggleOpen = (id) => setOverrides(p => ({ ...p, [id]: !isOpen(id) }));

  return (
    <div style={sectionCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <ListChecks size={18} color={BRAND.blue} />
        <strong style={{ fontSize: 16, color: BRAND.ink }}>Milestones</strong>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {VIDEO_MILESTONES.map((m, i) => (
          <MilestoneRow
            key={m.id} m={m} index={i} videoId={videoId}
            approval={approvedMap[m.id] || null}
            assets={assetsByMilestone[m.id] || []}
            open={isOpen(m.id)} onToggle={() => toggleOpen(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MilestoneRow({ m, index, videoId, approval, assets, open, onToggle }) {
  const { actions, showMsg } = useStore();
  const userName = useUserName();
  const ui = MILESTONE_UI[m.id] || MILESTONE_UI.script;
  const fileRef = useRef(null);
  const [progress, setProgress] = useState(null); // null = idle
  const [busy, setBusy] = useState(false);
  // Inline "link a Google Doc" form (alternative to uploading a file).
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrlInput, setLinkUrlInput] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const stageLabel = STAGE_LABEL[m.phase]?.[m.stage] || m.stage;
  const latest = assets[0] || null;

  async function handleFile(file) {
    if (!file) return;
    setProgress(0);
    try { await actions.uploadMilestoneAsset(videoId, m.id, file, { onProgress: setProgress }); showMsg('Uploaded'); }
    catch (e) { showMsg(e.message || 'Upload failed'); }
    finally { setProgress(null); if (fileRef.current) fileRef.current.value = ''; }
  }
  async function handleLink() {
    const url = linkUrlInput.trim();
    if (!/^https?:\/\//i.test(url)) { showMsg('Enter a full URL starting with http:// or https://'); return; }
    setBusy(true);
    try {
      await actions.linkMilestoneAsset(videoId, m.id, url, linkTitle.trim() || null);
      showMsg('Linked');
      setLinkOpen(false); setLinkUrlInput(''); setLinkTitle('');
    } catch (e) { showMsg(e.message || 'Could not link'); }
    finally { setBusy(false); }
  }
  async function approve(val) {
    setBusy(true);
    try { await actions.approveVideoMilestone(videoId, m.id, val); }
    catch { /* handled in action */ }
    finally { setBusy(false); }
  }
  function removeAsset(id) {
    if (window.confirm('Delete this file?')) actions.deleteMilestoneAsset(videoId, id).catch(() => {});
  }

  return (
    <div style={{ borderTop: index === 0 ? 'none' : '1px solid ' + BRAND.border }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', flexWrap: 'wrap' }}>
        <button onClick={onToggle}
          style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none',
            cursor: 'pointer', flex: 1, minWidth: 180, textAlign: 'left', padding: 0 }}>
          {open ? <ChevronDown size={16} color={BRAND.muted} /> : <ChevronRight size={16} color={BRAND.muted} />}
          {approval ? <CheckCircle2 size={18} color="#16A34A" /> : <Circle size={18} color={BRAND.muted} style={{ opacity: 0.5 }} />}
          <div>
            <div style={{ fontWeight: 600, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
              {m.label}
              {assets.length > 0 && <span style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500 }}>· {assets.length} file{assets.length === 1 ? '' : 's'}</span>}
            </div>
            <div style={{ fontSize: 12, color: BRAND.muted }}>→ moves to {stageLabel}</div>
          </div>
        </button>
        {approval ? (
          <>
            <span style={{ fontSize: 12, color: '#16A34A', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={13} /> Approved by {userName(approval.approvedBy)} · {fmtDate(approval.approvedAt)}
            </span>
            <button onClick={() => approve(false)} disabled={busy} className="btn-ghost" title="Un-approve">Undo</button>
          </>
        ) : (
          <button onClick={() => approve(true)} disabled={busy || assets.length === 0} className="btn"
            title={assets.length === 0 ? 'Upload content first' : undefined}>
            {busy ? 'Approving…' : 'Approve'}
          </button>
        )}
      </div>

      {open && (
        <div style={{ padding: '0 0 16px 26px' }}>
          <input ref={fileRef} type="file" accept={ui.accept} style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files?.[0])} />
          <div
            onClick={() => progress == null && fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); if (progress == null) handleFile(e.dataTransfer.files?.[0]); }}
            style={{ border: `2px dashed ${BRAND.border}`, borderRadius: 10, padding: 16, textAlign: 'center',
              color: BRAND.muted, cursor: progress == null ? 'pointer' : 'default', fontSize: 13 }}>
            {progress == null ? (
              <><Upload size={15} /> <span style={{ marginLeft: 6 }}>{ui.hint}</span></>
            ) : (
              <div>
                <div style={{ marginBottom: 8 }}>Uploading… {progress}%</div>
                <div style={{ height: 6, background: BRAND.border, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: progress + '%', height: '100%', background: BRAND.blue, transition: 'width .2s' }} />
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: 8 }}>
            {!linkOpen ? (
              <button onClick={() => setLinkOpen(true)} className="btn-ghost"
                style={{ fontSize: 12, padding: '4px 8px' }}>
                <Link2 size={13} /> <span style={{ marginLeft: 4 }}>Link a Google Doc</span>
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10,
                border: '1px solid ' + BRAND.border, borderRadius: 8, background: '#FAFBFC' }}>
                <input
                  type="url" style={ctrl} autoFocus
                  placeholder="Paste a Google Doc or Drive link (https://…)"
                  value={linkUrlInput}
                  onChange={(e) => setLinkUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleLink(); }}
                />
                <input
                  type="text" style={ctrl}
                  placeholder="Label (optional, e.g. “Script v2”)"
                  value={linkTitle}
                  onChange={(e) => setLinkTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleLink(); }}
                />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setLinkOpen(false); setLinkUrlInput(''); setLinkTitle(''); }}
                    className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
                  <button onClick={handleLink} disabled={busy} className="btn" style={{ fontSize: 12 }}>
                    {busy ? 'Linking…' : 'Link document'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {latest && <MilestonePreview asset={latest} />}

          {assets.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {assets.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <FileText size={14} color={BRAND.muted} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</div>
                    <div style={{ fontSize: 11, color: BRAND.muted }}>{userName(a.uploadedBy)} · {fmtDate(a.createdAt)}{a.driveUrl ? ' · in Drive' : ''}</div>
                  </div>
                  {a.url && <a href={a.url} target="_blank" rel="noreferrer" className="btn-ghost" title="View"><ExternalLink size={13} /></a>}
                  <button onClick={() => removeAsset(a.id)} className="btn-ghost" title="Delete"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Text input that only saves on blur / Enter, re-syncing when the value reloads.
function InlineText({ value, placeholder, onSave, style }) {
  const [draft, setDraft] = useState(value || '');
  useEffect(() => { setDraft(value || ''); }, [value]);
  const commit = () => { const v = draft.trim() || null; if (v !== (value || null)) onSave(v); };
  return (
    <input
      type="text" style={style || ctrl} value={draft} placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}
