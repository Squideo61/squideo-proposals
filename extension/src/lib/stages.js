// Pipeline-stage definitions for the extension. **This is a copy of
// src/lib/stages.js** — the extension's esbuild bundle is intentionally
// isolated from the web app's Vite bundle, so we can't import across the
// boundary. When the canonical file changes, copy this one across too.

export const PIPELINE_STAGES = [
  { id: 'lead',          label: 'Lead',          color: '#94A3B8', bg: '#F1F5F9', fg: '#475569' },
  { id: 'responded',     label: 'Responded',     color: '#7C3AED', bg: '#EDE9FE', fg: '#5B21B6' },
  { id: 'proposal_sent', label: 'Proposal Sent', color: '#0EA5E9', bg: '#E0F2FE', fg: '#0369A1' },
  { id: 'viewed',        label: 'Viewed',        color: '#FB923C', bg: '#FFF7ED', fg: '#C2410C' },
  { id: 'signed',        label: 'Signed',        color: '#2BB8E6', bg: '#E0F9FF', fg: '#0284C7' },
  { id: 'paid',          label: 'Paid',          color: '#16A34A', bg: '#DCFCE7', fg: '#166534' },
  { id: 'long_term',     label: 'Long-term',     color: '#A78BFA', bg: '#F5F3FF', fg: '#6D28D9', defaultCollapsed: true },
  { id: 'lost',          label: 'Lost',          color: '#94A3B8', bg: '#FEE2E2', fg: '#991B1B', defaultCollapsed: true },
];

export const STAGE_COLOURS = Object.fromEntries(
  PIPELINE_STAGES.map(s => [s.id, { bg: s.bg, fg: s.fg }])
);
