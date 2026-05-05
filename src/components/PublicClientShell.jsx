import React, { useEffect, useRef, useState } from 'react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { ClientView } from './ClientView.jsx';
import { ThankYouView } from './ThankYouView.jsx';
import { Toast } from './ui.jsx';

function readThanksFlag() {
  return new URLSearchParams(window.location.search).get('thanks') === '1';
}

export function PublicClientShell({ proposalId }) {
  const { state, actions, showMsg, toast } = useStore();
  const verifiedRef = useRef(false);
  const [showThanks, setShowThanks] = useState(readThanksFlag);

  useEffect(() => {
    actions.loadPublicProposal(proposalId);
  }, [proposalId]); // eslint-disable-line

  // Keep our flag in sync with browser navigation (back/forward).
  useEffect(() => {
    const onPop = () => setShowThanks(readThanksFlag());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
        // Drop session_id and land on the thank-you page so the client sees a
        // dedicated success moment instead of the full proposal scroll.
        const clean = new URL(window.location.href);
        clean.searchParams.delete('session_id');
        clean.searchParams.set('thanks', '1');
        window.history.replaceState({}, '', clean.toString());
        setShowThanks(true);
        showMsg('Payment confirmed! Thank you.');
      })
      .catch(() => showMsg('Could not verify payment - please contact us.'));
  }, [proposalId]); // eslint-disable-line

  if (state.loading) {
    return (
      <div style={{ minHeight: '100vh', background: BRAND.paper, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: BRAND.muted }}>Loading proposal…</div>
      </div>
    );
  }

  const proposal = state.proposals[proposalId];
  const signed = state.signatures[proposalId];
  const payment = state.payments[proposalId];

  // Only show the dedicated thank-you page if a signature actually exists.
  // A bare ?thanks=1 with no signature falls through to the proposal so the
  // client can sign it.
  if (showThanks && signed) {
    return (
      <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink }}>
        <ThankYouView
          proposalId={proposalId}
          proposal={proposal}
          signed={signed}
          payment={payment}
          showMsg={showMsg}
          onViewProposal={() => {
            const clean = new URL(window.location.href);
            clean.searchParams.delete('thanks');
            clean.searchParams.delete('download');
            window.history.pushState({}, '', clean.toString());
            setShowThanks(false);
          }}
        />
        <Toast msg={toast} />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink }}>
      <ClientView
        id={proposalId}
        onBack={null}
        useRealStripe={true}
        onSigned={() => {
          const clean = new URL(window.location.href);
          clean.searchParams.set('thanks', '1');
          clean.searchParams.set('celebrate', '1');
          window.history.pushState({}, '', clean.toString());
          setShowThanks(true);
        }}
      />
      <Toast msg={toast} />
    </div>
  );
}
