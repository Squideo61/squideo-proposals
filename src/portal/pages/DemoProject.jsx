// The sample project — the real review surface, driven by a fixture.
//
// Almost no agency lets a prospect touch the client workflow before they buy.
// This is the strongest thing in the whole funnel for exactly that reason: it
// isn't a claim about how good the process is, it's the process.

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RotateCcw, Info } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { usePortal } from '../PortalContext.jsx';
import { navigate } from '../PortalApp.jsx';
import { portalApi } from '../api.js';
import { VideoRevision } from '../../components/revision/VideoRevision.jsx';
import { createDemoRevApi, resetDemo } from '../demo/demoRevApi.js';
import { DEMO_TOKEN } from '../demo/fixtures.js';

export default function DemoProject() {
  const { user, showToast } = usePortal();
  const [config, setConfig] = useState(null);
  const [data, setData] = useState(null);
  const [nonce, setNonce] = useState(0);

  const identity = useMemo(
    () => (user?.email ? { name: user.name || null, email: user.email } : null),
    [user],
  );

  useEffect(() => {
    portalApi.get('demo-project')
      .then((d) => setConfig(d?.demo || {}))
      .catch(() => setConfig({}));
  }, []);

  const { api } = useMemo(() => {
    if (!config) return { api: null };
    const built = createDemoRevApi({ config, identity, onChange: setData });
    setData(built.load());
    return built;
    // `nonce` forces a rebuild after "start over".
  }, [config, identity, nonce]);

  const startOver = () => {
    resetDemo();
    setNonce((n) => n + 1);
    showToast('Sample project reset');
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 16px', flexShrink: 0,
      }}>
        <button
          onClick={() => navigate('#/')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
            border: 'none', color: BRAND.blue, cursor: 'pointer', fontSize: 13,
            fontWeight: 600, fontFamily: 'inherit', padding: 0,
          }}
        >
          <ArrowLeft size={14} /> Back to projects
        </button>
        <div style={{ flex: 1 }} />
        <button
          onClick={startOver}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff',
            border: `1px solid ${BRAND.border}`, borderRadius: 8, cursor: 'pointer',
            color: '#5A7382', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            padding: '6px 12px',
          }}
        >
          <RotateCcw size={13} /> Start over
        </button>
      </div>

      {/* Says "sample" without shouting. Amber like the staff manage-mode banner
          would read as a warning; this is an invitation. */}
      <div style={{
        display: 'flex', gap: 9, alignItems: 'flex-start',
        margin: '0 16px 10px', padding: '10px 13px', borderRadius: 9,
        background: '#F3F9FC', border: '1px solid #CFE6F2',
        fontSize: 13, lineHeight: 1.55, color: '#41627A', flexShrink: 0,
      }}>
        <Info size={15} style={{ flexShrink: 0, marginTop: 2, color: BRAND.blue }} />
        <div>
          <strong style={{ color: BRAND.ink }}>This is a sample project.</strong>{' '}
          Everything works — click the video to leave a comment at that exact second,
          reply to one, switch between versions, approve it. Nothing you do here reaches
          anyone, and it resets when you close the tab.
        </div>
      </div>

      {!data ? (
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>
          Loading the sample project…
        </div>
      ) : !data.videos?.[0]?.versions?.[0]?.videoUrl ? (
        // An unconfigured demo is a staff problem, not a client-facing error —
        // say plainly what's missing rather than showing an empty player.
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>
          The sample video hasn't been set up yet.<br />
          <span style={{ fontSize: 13 }}>Admin → Crash course → Sample project.</span>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, background: BRAND.paper, color: BRAND.ink }}>
          <VideoRevision
            key={nonce}
            token={DEMO_TOKEN}
            data={data}
            api={api}
            showMsg={showToast}
            identity={identity}
            embedded
          />
        </div>
      )}
    </div>
  );
}
