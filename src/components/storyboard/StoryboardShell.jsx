import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Toast } from '../ui.jsx';
import { StoryboardRevision } from './StoryboardRevision.jsx';

// Public, unauthenticated entry point for a client storyboard link
// (/?storyboard=<share_token>). Mirrors RevisionShell: load once, render the
// viewer, surface a friendly message if the link is dead.
export function StoryboardShell({ token }) {
  const { actions, toast } = useStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

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
      <StoryboardRevision token={token} data={data} />
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
