import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Toast } from '../ui.jsx';
import { VideoRevision } from './VideoRevision.jsx';
import { PortalReturnBar } from './PortalReturnBar.jsx';

// Public, unauthenticated entry point for a client revision link
// (/?revision=<share_token>). Mirrors PublicClientShell: load once, render the
// viewer, surface a friendly message if the link is dead.
// The token covers every video on the project, so an optional &item=<videoId>
// (and &draft=<versionId>) says which one the link was sent about — emails and
// portal rows now carry it. Without it the viewer opens the newest draft still
// waiting on the client.
export function RevisionShell({ token }) {
  const { actions, showMsg, toast } = useStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const params = new URLSearchParams(window.location.search);
  const videoId = params.get('item');
  const draftId = params.get('draft');

  useEffect(() => {
    let alive = true;
    actions.loadPublicRevision(token)
      .then(d => { if (alive) setData(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [token]); // eslint-disable-line

  if (error) {
    return (
      <Centered>This revision link is no longer available.</Centered>
    );
  }
  if (!data) {
    return <Centered>Loading revision…</Centered>;
  }

  return (
    <div style={{ background: BRAND.paper, color: BRAND.ink }}>
      <PortalReturnBar />
      {/* Anonymous share-token page: the CRM store IS the data adapter, and no
          identity is pre-set so the name/email gate is shown. */}
      <VideoRevision token={token} data={data} api={actions} showMsg={showMsg}
        initialVideoId={videoId} initialVersionId={draftId} />
      <Toast msg={toast} />
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, display: 'flex',
      alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontSize: 14, color: BRAND.muted }}>{children}</div>
    </div>
  );
}
