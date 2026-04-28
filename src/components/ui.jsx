import React, { useEffect, useId } from 'react';
import { BRAND } from '../theme.js';
import { SQUIDEO_LOGO } from '../defaults.js';
import { formatGBP, useIsMobile } from '../utils.js';

export function Logo({ size, dark }) {
  const height = size || 36;
  return (
    <img
      src={SQUIDEO_LOGO}
      alt="Squideo"
      style={{
        height,
        width: 'auto',
        display: 'block',
        ...(dark ? {} : { background: BRAND.ink, padding: '4px 10px', borderRadius: 8 })
      }}
    />
  );
}

export function Section({ title, children }) {
  const isMobile = useIsMobile();
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 16 }}>
      <h2 className="section-label">{title}</h2>
      {children}
    </div>
  );
}

export function Field({ label, children, htmlFor }) {
  const fallbackId = useId();
  const targetId = htmlFor || fallbackId;
  const child = React.isValidElement(children) && !children.props.id
    ? React.cloneElement(children, { id: targetId })
    : children;
  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={targetId} style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{label}</label>
      {child}
    </div>
  );
}

export function PageTitle({ children }) {
  const isMobile = useIsMobile();
  return (
    <h2 style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, margin: isMobile ? '24px 0 10px' : '32px 0 12px', paddingBottom: 8, borderBottom: '2px solid ' + BRAND.blue }}>
      {children}
    </h2>
  );
}

export function PriceRow({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: bold ? 'none' : '1px solid ' + BRAND.border, fontWeight: bold ? 700 : 400, fontSize: bold ? 16 : 14 }}>
      <span>{label}</span>
      <span>{formatGBP(value)}</span>
    </div>
  );
}

export function PaymentOption({ selected, onSelect, title, desc, disabled }) {
  return (
    <label onClick={onSelect} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 16, border: '2px solid ' + (selected ? BRAND.blue : BRAND.border), borderRadius: 10, cursor: disabled ? 'default' : 'pointer', background: selected ? '#F0F9FF' : 'white' }}>
      <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid ' + (selected ? BRAND.blue : BRAND.muted), flexShrink: 0, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {selected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: BRAND.blue }} />}
      </div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>{desc}</div>
      </div>
    </label>
  );
}

export function Badge({ color, children }) {
  const colors = {
    green:  { bg: '#E8F5E9', fg: '#2E7D32' },
    yellow: { bg: '#FFF8E1', fg: '#B26A00' },
    blue:   { bg: '#E3F2FD', fg: '#0D47A1' },
    orange: { bg: '#FFF3E0', fg: '#E65100' },
    grey:   { bg: '#ECEFF1', fg: '#455A64' }
  };
  const c = colors[color] || colors.green;
  return (
    <span style={{ background: c.bg, color: c.fg, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12 }}>
      {children}
    </span>
  );
}

export function Modal({ children, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15, 42, 61, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 20 }}>
      <div role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ background: 'white', borderRadius: 12, padding: 24, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', maxHeight: '90vh', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

export function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: BRAND.ink, color: 'white', padding: '12px 20px', borderRadius: 8, fontSize: 14, fontWeight: 500, zIndex: 3000, maxWidth: '90vw', textAlign: 'center' }}>
      {msg}
    </div>
  );
}
