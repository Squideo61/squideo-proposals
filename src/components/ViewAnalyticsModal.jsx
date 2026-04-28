import React, { useEffect, useState } from 'react';
import { BarChart3, Clock, Eye, Globe, MapPin, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatDuration, formatProposalNumber } from '../utils.js';

function relativeTime(iso) {
  if (!iso) return '';
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

function parseUA(ua) {
  if (!ua) return { device: 'Unknown', browser: '' };
  const lower = ua.toLowerCase();
  const device = /mobi|iphone|android(?!.*tablet)|ipod/i.test(ua)
    ? 'Mobile'
    : /ipad|tablet/i.test(ua)
      ? 'Tablet'
      : 'Desktop';
  let browser = '';
  if (lower.includes('edg/')) browser = 'Edge';
  else if (lower.includes('chrome/') && !lower.includes('chromium')) browser = 'Chrome';
  else if (lower.includes('firefox/')) browser = 'Firefox';
  else if (lower.includes('safari/')) browser = 'Safari';
  return { device, browser };
}

function formatLocation(s) {
  const parts = [s.city, s.region, s.country].filter(Boolean);
  return parts.join(', ') || 'Unknown';
}

export function ViewAnalyticsModal({ proposal, onClose }) {
  const { state, actions } = useStore();
  const [loading, setLoading] = useState(true);
  const sessions = state.viewSessions[proposal.id] || [];

  useEffect(() => {
    setLoading(true);
    actions.loadViewSessions(proposal.id).finally(() => setLoading(false));
  }, [proposal.id, actions]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalOpens = sessions.length;
  const uniqueIps = new Set(sessions.map((s) => s.ip_address).filter(Boolean)).size;
  const totalDuration = sessions.reduce((acc, s) => acc + (Number(s.duration_seconds) || 0), 0);
  const number = proposal._number ? formatProposalNumber(proposal._number) : '';
  const title = (number ? number + ' · ' : '') + (proposal.clientName || 'Untitled proposal');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 42, 61, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: 20,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 12,
          padding: 0,
          width: '100%',
          maxWidth: 760,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid ' + BRAND.border,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BarChart3 size={18} color={BRAND.blue} />
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Viewing analytics</h3>
              <div style={{ fontSize: 12, color: BRAND.muted }}>{title}</div>
            </div>
          </div>
          <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
        </header>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 10,
              marginBottom: 20,
            }}
          >
            <Stat icon={Eye} label="Total opens" value={totalOpens} />
            <Stat icon={Globe} label="Unique IPs" value={uniqueIps} />
            <Stat icon={Clock} label="Total time" value={formatDuration(totalDuration)} />
          </div>

          {loading && sessions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: BRAND.muted, fontSize: 13 }}>
              Loading sessions…
            </div>
          ) : sessions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: BRAND.muted, fontSize: 13 }}>
              <Eye size={32} color={BRAND.muted} style={{ marginBottom: 8 }} />
              <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink, marginBottom: 4 }}>No views yet</div>
              <div>Once the client opens the proposal link, sessions will appear here.</div>
            </div>
          ) : (
            <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#F8FAFC', textAlign: 'left' }}>
                      <Th>Opened</Th>
                      <Th>Location</Th>
                      <Th>IP</Th>
                      <Th>Duration</Th>
                      <Th>Device</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const ua = parseUA(s.user_agent);
                      return (
                        <tr key={s.session_id} style={{ borderTop: '1px solid ' + BRAND.border }}>
                          <Td>
                            <div style={{ fontWeight: 600 }}>{relativeTime(s.opened_at)}</div>
                            <div style={{ fontSize: 11, color: BRAND.muted }}>
                              {new Date(s.opened_at).toLocaleString('en-GB')}
                            </div>
                          </Td>
                          <Td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <MapPin size={12} color={BRAND.muted} />
                              <span>{formatLocation(s)}</span>
                            </div>
                          </Td>
                          <Td><code style={{ fontSize: 12 }}>{s.ip_address || '—'}</code></Td>
                          <Td>{formatDuration(s.duration_seconds)}</Td>
                          <Td>{ua.device}{ua.browser ? ' · ' + ua.browser : ''}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ marginTop: 14, fontSize: 11, color: BRAND.muted }}>
            Time-on-page only counts when the tab is visible. Location is derived from the client's IP via Vercel and may be approximate.
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
