// A client's own logo, served as bytes by /api/portal-logo — which resolves it
// wherever it came from: the organisation's uploaded logo first, else the newest
// logo on one of their proposals. So a logo added in the proposal builder shows
// up on the deal, the project and the portal without being re-uploaded.
//
// It sits on a white chip because a customer's mark is usually dark-on-
// transparent and some of our chrome is navy — the chip guarantees contrast
// whatever they gave us. Renders nothing if the image fails, so a client with no
// logo simply shows nothing rather than a broken image (no "has logo?" query
// needed at the call site).
import React, { useState } from 'react';

// /api/portal-logo?c=<companyId> — public by necessity (email clients fetch it
// with no cookies) and keyed by an unguessable company id.
export function companyLogoSrc(companyId) {
  return companyId ? `/api/portal-logo?c=${encodeURIComponent(companyId)}` : null;
}

export default function ClientLogo({
  src, companyId, alt = '', height = 22, maxWidth = 160, chip = true, style = {},
}) {
  const [broken, setBroken] = useState(false);
  const url = src || companyLogoSrc(companyId);
  if (!url || broken) return null;
  const img = (
    <img
      src={url}
      alt={alt}
      onError={() => setBroken(true)}
      style={{ display: 'block', height, maxWidth, objectFit: 'contain' }}
    />
  );
  if (!chip) return img;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: '#fff', borderRadius: 8, padding: '4px 8px',
      ...style,
    }}>
      {img}
    </span>
  );
}
