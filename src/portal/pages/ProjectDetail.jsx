// Single-project view: phase timeline, ball-in-court next step (with the
// in-page PO-number form), videos, review/storyboard deep-links, documents
// and the extras teaser.
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi, mediaUrl } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import {
  Card, CourtBanner, PhaseTimeline, StatusPill, EmptyState, FileRow, SectionHeading, ProjectTasks,
  ProjectSchedule, fmtDate,
} from '../components.jsx';
import { runCta } from './Dashboard.jsx';
import {
  ArrowLeft, Video, PlayCircle, LayoutPanelTop, Sparkles, Upload, FileSignature, Mic, Download, Lock,
} from 'lucide-react';

function TasksCard({ tasks, dealId }) {
  const open = tasks.filter((t) => t.status !== 'done');
  if (!tasks.length) return null;
  return (
    <Card>
      <SectionHeading>Your tasks{open.length ? ` · ${open.length} to do` : ' · all done ✅'}</SectionHeading>
      <ProjectTasks tasks={tasks} onCta={(cta) => runCta(cta, dealId)} />
    </Card>
  );
}

export default function ProjectDetail({ dealId }) {
  const { showToast } = usePortal();
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [poNumber, setPoNumber] = useState('');
  const [poBusy, setPoBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = async () => {
    try {
      const data = await portalApi.get(`project?dealId=${encodeURIComponent(dealId)}`);
      setProject(data.project);
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitPo = async (e) => {
    e.preventDefault();
    setPoBusy(true);
    try {
      await portalApi.post('po-number', { dealId, poNumber });
      showToast('PO number sent ✓');
      setPoNumber('');
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setPoBusy(false);
    }
  };

  const uploadDoc = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      await portalApi.upload(`files?scope=deal&dealId=${encodeURIComponent(dealId)}`, file);
      showToast('Uploaded ✓ — our team can see it now');
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setUploading(false);
    }
  };

  if (error) {
    return (
      <div>
        <a href="#/" className="btn-link" style={{ fontSize: 13 }}><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Back</a>
        <Card style={{ marginTop: 14 }}><EmptyState title="Project not found" body={error} /></Card>
      </div>
    );
  }
  if (!project) {
    return <div style={{ color: BRAND.muted, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading project…</div>;
  }

  const showPoForm = project.nextStep?.cta?.action === 'po-number';
  const scheduledVideos = (project.videos || []).filter((v) => v.schedule?.milestones?.length);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <a href="#/" className="btn-link" style={{ fontSize: 13 }}><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> All projects</a>
        <h1 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 800, color: BRAND.ink }}>{project.title}</h1>
        <div style={{ fontSize: 12.5, color: BRAND.muted }}>
          Started {fmtDate(project.createdAt)}
          {project.deliveryDeadline ? ` · delivery ${fmtDate(project.deliveryDeadline)}` : ''}
        </div>
      </div>

      {project.inProduction && (
        <Card><PhaseTimeline production={project.production} /></Card>
      )}

      {/* Suppress the banner when it's just echoing the task list below it. */}
      {!(project.nextStep?.fromTasks && project.tasks?.length > 0) && (
        <CourtBanner nextStep={project.nextStep} onCta={(cta) => runCta(cta, project.id)} />
      )}

      {project.tasks?.length > 0 && <TasksCard tasks={project.tasks} dealId={project.id} />}

      {showPoForm && (
        <Card>
          <SectionHeading>Send us your PO number</SectionHeading>
          <form onSubmit={submitPo} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              className="input"
              required
              maxLength={60}
              placeholder="e.g. PO-2026-0042"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            />
            <button className="btn" type="submit" disabled={poBusy}>{poBusy ? 'Sending…' : 'Submit PO number'}</button>
          </form>
        </Card>
      )}

      {/* The schedule the team planned this against. Per video, because a
          multi-video project runs them on separate timelines and one merged
          list would be unreadable — with the deal's own schedule as the
          project-wide fallback for a job planned from the deal page. Shown
          only once dates actually exist; an empty timeline promises nothing
          and looks like something is broken. */}
      {scheduledVideos.length > 0 ? (
        <Card>
          <SectionHeading>Schedule</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {scheduledVideos.map((v) => (
              <ProjectSchedule
                key={v.id}
                schedule={v.schedule}
                // One video needs no heading — it would just repeat the card's.
                title={scheduledVideos.length > 1 ? v.title : null}
              />
            ))}
          </div>
        </Card>
      ) : project.schedule ? (
        <Card>
          <SectionHeading>Schedule</SectionHeading>
          <ProjectSchedule schedule={project.schedule} title={null} />
        </Card>
      ) : null}

      {project.videos?.length > 0 && (
        <Card>
          <SectionHeading>Videos</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {project.videos.map((v) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 4px', borderBottom: `1px solid ${BRAND.border}` }}>
                <Video size={16} color={BRAND.muted} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: BRAND.ink }}>{v.title}</div>
                  {v.voiceover && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>
                      <Mic size={12} /> {v.voiceover.artistName}
                    </div>
                  )}
                </div>
                {/* Show the live board stage (client-friendly) as the status —
                    the old per-video `status` field is vestigial and stays
                    "Not started" while the stage advances. */}
                {v.production?.stageLabel
                  ? <StatusPill label={v.production.stageLabel} color={v.production.phaseColor || BRAND.blue} />
                  : <StatusPill label={v.statusLabel} color={v.statusColor} />}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Once work has started this card always renders, even with nothing in
          it yet. "When do I get to see something?" is the question a client is
          most often sitting on at this point, and an absent card answers it
          with silence. The sample is the honest answer: here's the thing
          you'll be sent, have a go on a made-up one while you wait. It
          disappears the moment there's real work to review. */}
      {(project.reviews?.length > 0 || project.storyboards?.length > 0) ? (
        <Card>
          <SectionHeading>Reviews & feedback</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(project.reviews || []).map((r, i) => (
              <div key={`rev-${i}`} style={{ display: 'flex', flexDirection: 'column' }}>
                <a
                  href={`#/review/${encodeURIComponent(r.shareToken)}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                    border: `1px solid ${BRAND.border}`,
                    borderRadius: r.approved && r.videoId ? '10px 10px 0 0' : 10,
                    borderBottom: r.approved && r.videoId ? 'none' : undefined,
                    textDecoration: 'none',
                    background: r.approved || r.feedbackSubmitted ? '#FAFBFC' : '#EAF7FC',
                  }}
                >
                  <PlayCircle size={19} color={BRAND.blue} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: BRAND.blue }}>Video review</div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>{r.title || 'Video review'}</div>
                    <div style={{ fontSize: 11.5, color: BRAND.muted }}>
                      {r.approved ? 'Approved ✓' : r.feedbackSubmitted ? 'Feedback sent — we’re on it' : 'Awaiting your feedback'}
                    </div>
                  </div>
                  <span className="btn-ghost" style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.blue }}>
                    {r.approved ? 'Watch' : 'Open review'}
                  </span>
                </a>
                {/* Once approved, the finished cut is downloadable — gated on the
                    final invoice being paid (or a staff release override). */}
                {r.approved && r.videoId && (
                  project.finalReleaseUnlocked ? (
                    <a
                      href={mediaUrl(`review-download?videoId=${encodeURIComponent(r.videoId)}`)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                        padding: '9px 14px', border: `1px solid ${BRAND.border}`, borderRadius: '0 0 10px 10px',
                        background: '#16A34A', color: '#fff', fontSize: 12.5, fontWeight: 700, textDecoration: 'none',
                      }}
                    >
                      <Download size={14} /> Download your video
                    </a>
                  ) : (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                      padding: '9px 14px', border: `1px solid ${BRAND.border}`, borderRadius: '0 0 10px 10px',
                      background: '#FFFBEB', color: '#92400E', fontSize: 12, fontWeight: 600,
                    }}>
                      <Lock size={13} /> Download unlocks once your final invoice is paid
                    </div>
                  )
                )}
              </div>
            ))}
            {(project.storyboards || []).map((s, i) => (
              <a
                key={`sb-${i}`}
                href={`#/storyboard/${encodeURIComponent(s.shareToken)}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                  border: `1px solid ${BRAND.border}`, borderRadius: 10, textDecoration: 'none',
                  background: s.approved || s.feedbackSubmitted ? '#FAFBFC' : '#EAF7FC',
                }}
              >
                <LayoutPanelTop size={19} color="#7C3AED" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: '#7C3AED' }}>Storyboard review</div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>{s.title || 'Storyboard'}</div>
                  <div style={{ fontSize: 11.5, color: BRAND.muted }}>
                    {s.approved ? 'Approved ✓' : s.feedbackSubmitted ? 'Feedback sent — we’re on it' : 'Awaiting your review'}
                  </div>
                </div>
                <span className="btn-ghost" style={{ fontSize: 12.5, fontWeight: 700, color: '#7C3AED' }}>
                  {s.approved ? 'View' : 'Open review'}
                </span>
              </a>
            ))}
          </div>
        </Card>
      ) : project.inProduction && (
        <Card>
          <SectionHeading>Reviews & feedback</SectionHeading>
          <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.6, marginBottom: 12 }}>
            Nothing to review yet. When your storyboard and then your first cut are ready
            they arrive here, and you'll get an email the moment each one lands.
          </div>
          <a
            href="#/demo"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 13px',
              border: `1px solid ${BRAND.border}`, borderRadius: 10, textDecoration: 'none',
              background: '#FAFBFC', color: BRAND.ink, fontSize: 13, fontWeight: 600,
            }}
          >
            <PlayCircle size={16} color={BRAND.blue} />
            See what reviewing one looks like
            <span style={{ color: BRAND.muted, fontWeight: 500 }}>· on a sample project</span>
          </a>
        </Card>
      )}

      {project.proposal && (
        <Card style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <FileSignature size={18} color={BRAND.muted} />
          <div style={{ flex: 1, fontSize: 13.5, color: BRAND.ink, fontWeight: 600 }}>
            {project.proposal.signed ? 'Your signed proposal' : 'Your proposal'}
          </div>
          <a
            className="btn-ghost"
            style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.blue }}
            href={`/?proposal=${encodeURIComponent(project.proposal.id)}${project.proposal.signed ? '&thanks=1&download=signed' : ''}`}
          >
            {project.proposal.signed ? 'View / download' : 'Review & sign'}
          </a>
        </Card>
      )}

      {project.extrasWindowOpen && (
        <Card
          onClick={() => { window.location.hash = `#/extras/${project.id}`; }}
          style={{ background: 'linear-gradient(135deg, #EAF7FC, #F3EFFF)', display: 'flex', alignItems: 'center', gap: 14 }}
        >
          <Sparkles size={22} color="#7C3AED" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 14.5, color: BRAND.ink }}>Boost this project with extras</div>
            <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 2 }}>
              {project.extrasAvailable > 0
                ? `${project.extrasAvailable} add-on${project.extrasAvailable === 1 ? '' : 's'} at exclusive portal prices — subtitles, cutdowns, translations and more.`
                : 'See add-ons available for this project.'}
            </div>
          </div>
          <span className="btn" style={{ background: '#7C3AED', flexShrink: 0 }}>View extras</span>
        </Card>
      )}

      <Card>
        <SectionHeading
          right={
            <label className="btn-ghost" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: BRAND.blue }}>
              <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload'}
              <input type="file" hidden disabled={uploading} onChange={(e) => { uploadDoc(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          }
        >
          Project documents
        </SectionHeading>
        {(project.files || []).length === 0 ? (
          <div style={{ fontSize: 13, color: BRAND.muted }}>
            Share scripts, briefs or anything useful for this project — your Squideo team sees uploads instantly.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {project.files.map((f) => (
              <FileRow
                key={f.id}
                filename={f.filename}
                sizeBytes={f.sizeBytes}
                createdAt={f.createdAt}
                onDownload={() => { window.location.href = mediaUrl(`download?scope=deal&id=${encodeURIComponent(f.id)}`); }}
              />
            ))}
          </div>
        )}
      </Card>

      {(project.extras || []).length > 0 && (
        <Card>
          <SectionHeading>Extras on this project</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {project.extras.map((x) => (
              <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ flex: 1, color: BRAND.ink }}>{x.description}</span>
                <span style={{ fontWeight: 700 }}>£{(x.amount || 0).toFixed(2)}</span>
                <StatusPill
                  label={x.status === 'paid' ? 'Paid' : x.status === 'invoiced' ? 'Invoiced' : 'On final invoice'}
                  color={x.status === 'paid' ? '#16A34A' : x.status === 'invoiced' ? '#0EA5E9' : '#F59E0B'}
                />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
