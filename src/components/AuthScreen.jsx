import React, { useEffect, useState } from 'react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Field, Logo } from './ui.jsx';
import { TwoFactorChallenge } from './TwoFactorChallenge.jsx';
import { TwoFactorEnrolment } from './TwoFactorEnrolment.jsx';

export function AuthScreen() {
  const { actions, showMsg } = useStore();
  const inviteToken = new URLSearchParams(window.location.search).get('invite');

  const [mode, setMode] = useState(inviteToken ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invitePreview, setInvitePreview] = useState(null);
  const [inviteState, setInviteState] = useState(inviteToken ? 'loading' : 'none'); // none | loading | valid | invalid
  const [challengeToken, setChallengeToken] = useState(null);
  const [enrolmentToken, setEnrolmentToken] = useState(null);

  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    api.get('/api/invites?token=' + encodeURIComponent(inviteToken))
      .then((data) => {
        if (cancelled) return;
        setInvitePreview(data);
        setEmail(data.email);
        setInviteState('valid');
      })
      .catch(() => {
        if (cancelled) return;
        setInviteState('invalid');
      });
    return () => { cancelled = true; };
  }, [inviteToken]);

  const stripInviteFromUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url.toString());
  };

  const submit = async () => {
    setError('');
    if (mode === 'signup') {
      if (!name.trim() || !password.trim()) { setError('All fields required'); return; }
      if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    } else {
      if (!email.trim() || !password.trim()) { setError('All fields required'); return; }
      if (!email.includes('@')) { setError('Enter a valid email'); return; }
    }
    setBusy(true);
    try {
      if (mode === 'signup') {
        const e = (invitePreview?.email || email).toLowerCase().trim();
        const resp = await api.post('/api/auth/signup', {
          email: e, name: name.trim(), password, inviteToken,
        });
        stripInviteFromUrl();
        if (resp.requiresEnrolment) {
          setEnrolmentToken(resp.enrolment_token);
        } else if (resp.user) {
          actions.signup(resp.user);
          showMsg('Welcome, ' + resp.user.name);
        }
      } else {
        const e = email.toLowerCase().trim();
        const resp = await api.post('/api/auth/login', { email: e, password });
        if (resp.requires2fa) {
          setChallengeToken(resp.challenge_token);
        } else if (resp.requiresEnrolment) {
          setEnrolmentToken(resp.enrolment_token);
        } else if (resp.user) {
          actions.login(resp.user);
          showMsg('Welcome back, ' + resp.user.name);
        }
      }
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const cancel2fa = () => {
    setChallengeToken(null);
    setEnrolmentToken(null);
    setPassword('');
  };

  if (challengeToken) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <TwoFactorChallenge
          challengeToken={challengeToken}
          onSuccess={({ user }) => {
            setChallengeToken(null);
            actions.login(user);
            showMsg('Welcome back, ' + user.name);
          }}
          onCancel={cancel2fa}
        />
      </div>
    );
  }

  if (enrolmentToken) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <TwoFactorEnrolment
          enrolmentToken={enrolmentToken}
          onSuccess={({ user }) => {
            setEnrolmentToken(null);
            actions.login(user);
            showMsg('Welcome, ' + user.name);
          }}
          onCancel={cancel2fa}
        />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 400, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <Logo size={40} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Squideo Proposals</div>
            <div style={{ fontSize: 12, color: BRAND.muted }}>
              {mode === 'login' ? 'Sign in to your account' : 'Accept your invite'}
            </div>
          </div>
        </div>

        {mode === 'signup' && inviteState === 'loading' && (
          <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 16 }}>Checking invite…</div>
        )}

        {mode === 'signup' && inviteState === 'invalid' && (
          <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 12 }}>
            This invite is invalid or has expired. Ask your workspace admin for a new one.
          </div>
        )}

        {mode === 'signup' && inviteState === 'valid' && (
          <>
            <Field label="Full name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoFocus />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={invitePreview?.email || email} readOnly disabled />
            </Field>
            <Field label="Password">
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </Field>
          </>
        )}

        {mode === 'login' && (
          <>
            <Field label="Email">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@squideo.co.uk" />
            </Field>
            <Field label="Password">
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </Field>
          </>
        )}

        {error && (
          <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {(mode === 'login' || (mode === 'signup' && inviteState === 'valid')) && (
          <button onClick={submit} disabled={busy} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 12 }}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        )}

        {mode === 'signup' && inviteState === 'invalid' && (
          <button
            onClick={() => { setMode('login'); setError(''); stripInviteFromUrl(); }}
            className="btn"
            style={{ width: '100%', justifyContent: 'center', padding: 12 }}
          >
            Back to sign in
          </button>
        )}

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: BRAND.muted }}>
          {mode === 'login'
            ? 'Account creation is by invite only. Contact your workspace admin if you need access.'
            : 'Already have an account? '}
          {mode === 'signup' && (
            <button
              onClick={() => { setMode('login'); setError(''); stripInviteFromUrl(); }}
              className="btn-link"
            >
              Sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
