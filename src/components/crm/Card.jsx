import React from 'react';
import { BRAND } from '../../theme.js';

export function Card({ title, count, action, children }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, minHeight: 120 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {title}{typeof count === 'number' ? <span style={{ color: BRAND.blue, marginLeft: 6 }}>· {count}</span> : null}
        </h3>
        {action}
      </div>
      {children}
    </div>
  );
}

export function Empty({ text }) {
  return <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted, fontStyle: 'italic' }}>{text}</div>;
}
