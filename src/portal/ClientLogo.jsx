// The client's own logo, lifted from their proposal and served as bytes by
// /api/portal-logo. It sits on a white chip because a customer's mark is
// usually dark-on-transparent and the portal chrome is navy — the chip
// guarantees contrast whatever they gave us. Renders nothing if the image
// fails, so a stale URL degrades to the plain Squideo header.
import React, { useState } from 'react';

export default function ClientLogo({ src, alt = '', height = 22, maxWidth = 160, style = {} }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: '#fff', borderRadius: 8, padding: '4px 8px',
      ...style,
    }}>
      <img
        src={src}
        alt={alt}
        onError={() => setBroken(true)}
        style={{ display: 'block', height, maxWidth, objectFit: 'contain' }}
      />
    </span>
  );
}
