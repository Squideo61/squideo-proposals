import React from 'react';
import { useStore } from '../store.jsx';

// Eight-colour palette derived from a hash of the email so each teammate
// always renders with the same colour even before they upload an avatar.
const PALETTE = [
  '#2BB8E6', '#16A34A', '#F59E0B', '#EF4444',
  '#8B5CF6', '#EC4899', '#0EA5E9', '#10B981',
];

function hashEmail(email) {
  const s = String(email || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initialFor(user, email) {
  const src = (user?.name || email || '?').trim();
  return src.charAt(0).toUpperCase();
}

export function Avatar({ email, size = 24, ring = true, title }) {
  const { state } = useStore();
  const user = email ? state.users?.[email] : null;
  const dimension = size;
  const tooltip = title ?? (user?.name ? `${user.name} (${email})` : email || 'Unassigned');
  const borderStyle = ring ? `1.5px solid white` : 'none';
  const shared = {
    width: dimension,
    height: dimension,
    borderRadius: '50%',
    flexShrink: 0,
    border: borderStyle,
    boxShadow: '0 0 0 1px rgba(15, 42, 61, 0.08)',
  };

  if (user?.avatar) {
    return (
      <img
        src={user.avatar}
        alt={user.name || email}
        title={tooltip}
        style={{ ...shared, objectFit: 'cover', display: 'block' }}
      />
    );
  }

  const colour = PALETTE[hashEmail(email) % PALETTE.length];
  return (
    <div
      title={tooltip}
      style={{
        ...shared,
        background: colour,
        color: 'white',
        fontWeight: 600,
        fontSize: Math.max(10, Math.round(dimension * 0.45)),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      {initialFor(user, email)}
    </div>
  );
}

// Render up to `max` overlapping avatars; remainder collapses into a +N chip.
// Used on task rows in both the deal detail and global Tasks views.
export function AvatarGroup({ emails, max = 3, size = 24 }) {
  const list = Array.isArray(emails) ? emails.filter(Boolean) : [];
  if (!list.length) return null;
  const visible = list.slice(0, max);
  const overflow = list.length - visible.length;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center' }}>
      {visible.map((email, i) => (
        <div key={email} style={{ marginLeft: i === 0 ? 0 : -8 }}>
          <Avatar email={email} size={size} />
        </div>
      ))}
      {overflow > 0 && (
        <div
          title={list.slice(max).join(', ')}
          style={{
            marginLeft: -8,
            width: size,
            height: size,
            borderRadius: '50%',
            background: '#E5E9EE',
            color: '#0F2A3D',
            fontSize: Math.max(10, Math.round(size * 0.4)),
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1.5px solid white',
            boxShadow: '0 0 0 1px rgba(15, 42, 61, 0.08)',
          }}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}
