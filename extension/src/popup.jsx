import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { auth } from './lib/api.js';

function Popup() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const s = await auth.status();
      setStatus(s);
    } catch (err) {
      setError(err.message || String(err));
    }
  };

  useEffect(() => { refresh(); }, []);

  const connect = async () => {
    setError('');
    setBusy(true);
    try {
      await auth.start();
      await refresh();
    } catch (err) {
      setError(err.message || 'Connect failed');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await auth.clear();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected;

  return (
    <div style={{ width: 280, padding: 16, fontFamily: '-apple-system, system-ui, sans-serif', color: '#0F2A3D' }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Squideo CRM</div>

      {status === null && <div style={{ fontSize: 13, color: '#6B7785' }}>Loading…</div>}

      {status && (
        <>
          <div style={{
            background: connected ? '#DCFCE7' : '#F1F5F9',
            border: '1px solid ' + (connected ? '#86EFAC' : '#E2E8F0'),
            borderRadius: 8, padding: '10px 12px', marginBottom: 12,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {connected ? 'Connected' : 'Not connected'}
            </div>
            {connected && status.expiresAt && (
              <div style={{ fontSize: 11, color: '#6B7785', marginTop: 2 }}>
                Session expires {new Date(status.expiresAt).toLocaleDateString('en-GB')}
              </div>
            )}
          </div>

          {connected ? (
            <button onClick={disconnect} disabled={busy} style={btnGhost}>
              {busy ? '…' : 'Disconnect'}
            </button>
          ) : (
            <button onClick={connect} disabled={busy} style={btn}>
              {busy ? 'Connecting…' : 'Connect to Squideo'}
            </button>
          )}

          {error && (
            <div style={{ marginTop: 10, background: '#FEE2E2', color: '#991B1B', fontSize: 12, padding: '6px 8px', borderRadius: 6 }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 11, color: '#6B7785', marginTop: 12, lineHeight: 1.4 }}>
            Once connected, open any thread in Gmail to see Squideo&apos;s deal context in the right sidebar.
          </div>
        </>
      )}
    </div>
  );
}

const btn = {
  width: '100%', background: '#2BB8E6', color: '#fff', border: 'none',
  padding: '10px 14px', borderRadius: 8, fontWeight: 600, fontSize: 13,
  cursor: 'pointer', fontFamily: 'inherit',
};
const btnGhost = {
  width: '100%', background: '#fff', color: '#0F2A3D',
  border: '1px solid #E5E9EE', padding: '10px 14px', borderRadius: 8,
  fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
};

const root = createRoot(document.getElementById('root'));
root.render(<Popup />);
