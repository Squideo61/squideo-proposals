// Shared centred layout for the portal's unauthenticated screens.
import React from 'react';
import { BRAND } from '../../theme.js';
import { SQUIDEO_LOGO } from '../../defaults.js';

export default function AuthShell({ children, footer = null }) {
  return (
    <div style={{
      minHeight: '100vh', background: BRAND.ink,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 16px 32px',
    }}>
      <img src={SQUIDEO_LOGO} alt="Squideo" style={{ height: 38, marginBottom: 10 }} />
      <div style={{ color: '#9FDFF5', fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 28 }}>
        Client Portal
      </div>
      <div style={{
        width: '100%', maxWidth: 420, background: '#fff',
        border: `1px solid ${BRAND.border}`, borderRadius: 16, padding: 28,
        boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
      }}>
        {children}
      </div>
      <div style={{ marginTop: 22, color: '#7E97A8', fontSize: 12.5, textAlign: 'center', lineHeight: 1.6 }}>
        {footer || <>Need help? Email <a href="mailto:hello@squideo.co.uk" style={{ color: '#9FDFF5' }}>hello@squideo.co.uk</a> or call 01482 738 656.</>}
      </div>
    </div>
  );
}

export function AuthField({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>{label}</div>
      {children}
    </label>
  );
}

export function AuthError({ children }) {
  if (!children) return null;
  return (
    <div style={{
      background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C',
      borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 14, lineHeight: 1.45,
    }}>
      {children}
    </div>
  );
}

export function AuthInfo({ children }) {
  if (!children) return null;
  return (
    <div style={{
      background: '#EAF7FC', border: '1px solid #A9E1F5', color: '#0B6E93',
      borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 14, lineHeight: 1.45,
    }}>
      {children}
    </div>
  );
}
