import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Toast } from '../ui.jsx';
import { StoryboardRevision } from './StoryboardRevision.jsx';
import { PortalReturnBar } from '../revision/PortalReturnBar.jsx';

// Public, unauthenticated entry point for a client storyboard link
// (/?storyboard=<share_token>). Mirrors RevisionShell: load once, render the
// viewer, surface a friendly message if the link is dead.
// An optional &draft=<versionId> opens the viewer on that specific draft — the
// per-draft "Copy link" buttons in the CRM produce those.
export function StoryboardShell({ token }) {
  const { actions, showMsg, toast } = useStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const draftId = new URLSearchParams(window.location.search).get('draft');

  useEffect(() => {
    let alive = true;
    actions.loadPublicStoryboard(token)
      .then(d => { if (alive) setData(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [token]); // eslint-disable-line

  if (error) {
    return <Centered>This storyboard link is no longer available.</Centered>;
  }
  if (!data) {
    return <Centered>Loading storyboard…</Centered>;
  }

  return (
    <div style={{ background: BRAND.paper, color: BRAND.ink }}>
      <PortalReturnBar />
      <StoryboardRevision token={token} data={data} api={actions} showMsg={showMsg} initialVersionId={draftId} />
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
