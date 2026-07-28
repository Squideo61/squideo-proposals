import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

// On the standalone /?revision= and /?storyboard= viewers, show a "Back to
// portal" bar ONLY when the visitor is a logged-in portal client (an anonymous
// reviewer who opened an emailed link has no portal account, so it stays hidden).
// The sq_portal cookie is HttpOnly, so we detect the session via a cheap /me call.
export function PortalReturnBar() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/portal/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.user) setShow(true); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!show) return null;
  return (
    <div style={{ background: '#0B1B26', padding: '8px 16px' }}>
      <a href="/portal" style={{ color: 'white', fontSize: 13, fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <ArrowLeft size={14} /> Back to portal
      </a>
    </div>
  );
}
