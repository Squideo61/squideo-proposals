import React, { useEffect, useRef } from 'react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { ClientView } from './ClientView.jsx';
import { Toast } from './ui.jsx';

export function PublicClientShell({ proposalId }) {
  const { state, actions, showMsg, toast } = useStore();
  const verifiedRef = useRef(false);

  useEffect(() => {
    actions.loadPublicProposal(proposalId);
  }, [proposalId]); // eslint-disable-line

  // Handle Stripe success redirect: ?proposal=ID&session_id=cs_xxx
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId || verifiedRef.current) return;
    verifiedRef.current = true;

    fetch(
      '/api/stripe/verify?session_id=' + encodeURIComponent(sessionId)
      + '&proposalId=' + encodeURIComponent(proposalId)
    )
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j.error || 'Verify failed')))
      .then(payment => {
        actions.savePayment(proposalId, payment);
        // Strip session_id from URL so refreshing doesn't re-verify
        const clean = new URL(window.location.href);
        clean.searchParams.delete('session_id');
        window.history.replaceState({}, '', clean.toString());
        showMsg('Payment confirmed! Thank you.');
      })
      .catch(() => showMsg('Could not verify payment — please contact us.'));
  }, [proposalId]); // eslint-disable-line

  if (state.loading) {
    return (
      <div style={{ minHeight: '100vh', background: BRAND.paper, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: BRAND.muted }}>Loading proposal…</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink }}>
      <ClientView id={proposalId} onBack={null} useRealStripe={true} />
      <Toast msg={toast} />
    </div>
  );
}
