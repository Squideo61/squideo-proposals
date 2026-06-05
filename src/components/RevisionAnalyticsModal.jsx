import React, { useEffect, useState } from 'react';
import { BarChart3, Eye, Users, MessageSquare, Send, CheckCircle2, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';

function relativeTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' hr ago';
  const d = Math.round(h / 24);
  if (d < 30) return d + ' days ago';
  return new Date(iso).toLocaleDateString('en-GB');
}

// Engagement analytics for a revision / storyboard project — mirrors the
// proposal ViewAnalyticsModal. `kind` is 'revision' or 'storyboard'; the matching
// store action (loadRevisionAnalytics / loadStoryboardAnalytics) is used.
export function RevisionAnalyticsModal({ project, kind = 'revision', onClose }) {
  const { actions } = useStore();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  useEffect(() => {
    const load = kind === 'storyboard' ? actions.loadStoryboardAnalytics : actions.loadRevisionAnalytics;
    setLoading(true);
    load(project.id).then((d) => setData(d || null)).finally(() => setLoading(false));
  }, [project.id, kind, actions]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totals = data?.totals || {};
  const viewers = data?.viewers || [];
  const itemWord = kind === 'storyboard' ? 'storyboards' : 'videos';

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15, 42, 61, 0.5)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 20 }}
    >
      <div
        role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
        style={{ background: 'white', borderRadius: 12, width: '100%', maxWidth: 760,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)', maxHeight: '90vh', display: 'flex',
          flexDirection: 'column', overflow: 'hidden' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid ' + BRAND.border }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BarChart3 size={18} color={BRAND.blue} />
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Engagement</h3>
              <div style={{ fontSize: 12, color: BRAND.muted }}>
                {project.title}{project.clientName ? ' · ' + project.clientName : ''}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
        </header>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 20 }}>
            <Stat icon={Eye} label="Total views" value={totals.views ?? 0} />
            <Stat icon={Users} label="Unique viewers" value={totals.uniqueViewers ?? 0} />
            <Stat icon={MessageSquare} label="Comments" value={totals.comments ?? 0} />
            <Stat icon={Send} label="Feedback sent" value={`${totals.feedbackSubmitted ?? 0} / ${totals.videoCount ?? 0}`} />
            <Stat icon={CheckCircle2} label="Approved" value={`${totals.approved ?? 0} / ${totals.videoCount ?? 0}`} />
          </div>

          {loading && !data ? (
            <div style={{ textAlign: 'center', padding: 40, color: BRAND.muted, fontSize: 13 }}>Loading…</div>
          ) : viewers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: BRAND.muted, fontSize: 13 }}>
              <Eye size={32} color={BRAND.muted} style={{ marginBottom: 8 }} />
              <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink, marginBottom: 4 }}>No viewers yet</div>
              <div>Once the client opens the share link, their activity appears here.</div>
            </div>
          ) : (
            <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#F8FAFC', textAlign: 'left' }}>
                      <Th>Viewer</Th>
                      <Th>Last viewed</Th>
                      <Th>Views</Th>
                      <Th>Comments</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewers.map((v) => (
                      <tr key={v.email} style={{ borderTop: '1px solid ' + BRAND.border }}>
                        <Td>
                          <div style={{ fontWeight: 600 }}>{v.name || v.email}</div>
                          {v.name && <div style={{ fontSize: 11, color: BRAND.muted }}>{v.email}</div>}
                        </Td>
                        <Td>{relativeTime(v.lastViewedAt)}</Td>
                        <Td>{v.viewCount || 0}</Td>
                        <Td>{v.commentCount || 0}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ marginTop: 14, fontSize: 11, color: BRAND.muted }}>
            Counts cover every draft across all {itemWord} in this project. "Feedback sent" and "Approved" are per {itemWord.slice(0, -1)}.
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: BRAND.muted, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
        <Icon size={12} />
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: BRAND.ink }}>{value}</div>
    </div>
  );
}

function Th({ children }) {
  return <th style={{ padding: '10px 12px', fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</th>;
}
function Td({ children }) {
  return <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>{children}</td>;
}
