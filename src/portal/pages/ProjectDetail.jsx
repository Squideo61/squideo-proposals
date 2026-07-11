// Single-project view: phase timeline, ball-in-court next step (with the
// in-page PO-number form), videos, review/storyboard deep-links, documents
// and the extras teaser.
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import {
  Card, CourtBanner, PhaseTimeline, StatusPill, EmptyState, FileRow, SectionHeading, fmtDate,
} from '../components.jsx';
import { runCta } from './Dashboard.jsx';
import {
  ArrowLeft, Video, PlayCircle, LayoutPanelTop, Sparkles, Upload, FileSignature,
} from 'lucide-react';

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

      <CourtBanner nextStep={project.nextStep} onCta={(cta) => runCta(cta, project.id)} />

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

      {project.videos?.length > 0 && (
        <Card>
          <SectionHeading>Videos</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {project.videos.map((v) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 4px', borderBottom: `1px solid ${BRAND.border}` }}>
                <Video size={16} color={BRAND.muted} />
                <div style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: BRAND.ink }}>{v.title}</div>
                {v.production?.stageLabel && <span style={{ fontSize: 11.5, color: BRAND.muted }}>{v.production.stageLabel}</span>}
                <StatusPill label={v.statusLabel} color={v.statusColor} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {(project.reviews?.length > 0 || project.storyboards?.length > 0) && (
        <Card>
          <SectionHeading>Reviews & feedback</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(project.reviews || []).map((r, i) => (
              <a
                key={`rev-${i}`}
                href={`/?revision=${encodeURIComponent(r.shareToken)}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                  border: `1px solid ${BRAND.border}`, borderRadius: 10, textDecoration: 'none',
                  background: r.approved || r.feedbackSubmitted ? '#FAFBFC' : '#EAF7FC',
                }}
              >
                <PlayCircle size={19} color={BRAND.blue} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>{r.title || 'Video review'}</div>
                  <div style={{ fontSize: 11.5, color: BRAND.muted }}>
                    {r.approved ? 'Approved ✓' : r.feedbackSubmitted ? 'Feedback sent — we’re on it' : 'Awaiting your feedback'}
                  </div>
                </div>
                <span className="btn-ghost" style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.blue }}>
                  {r.approved ? 'Watch' : 'Open review'}
                </span>
              </a>
            ))}
            {(project.storyboards || []).map((s, i) => (
              <a
                key={`sb-${i}`}
                href={`/?storyboard=${encodeURIComponent(s.shareToken)}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                  border: `1px solid ${BRAND.border}`, borderRadius: 10, textDecoration: 'none',
                  background: s.approved || s.feedbackSubmitted ? '#FAFBFC' : '#EAF7FC',
                }}
              >
                <LayoutPanelTop size={19} color="#7C3AED" />
                <div style={{ flex: 1 }}>
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
                onDownload={() => { window.location.href = `/api/portal/download?scope=deal&id=${encodeURIComponent(f.id)}`; }}
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
