// @vitest-environment jsdom
//
// A client's proposal link has to survive the order its requests come back in.
//
// The page asks two things at once: who is signed in (the store's session
// check) and the proposal itself. A client isn't signed in, so the session check
// is usually back first — and it clears the store's shared `loading` flag while
// the proposal is still on its way. The proposal view then mounted with nothing
// to show, took its early "not found" return, and rendered in full a beat later
// when the proposal landed. A hook sitting below that early return runs for the
// first time on that second render, which React refuses outright (minified
// error #310): the Monthly Plan effect did exactly that, and every client whose
// session check won the race got "Something went wrong" instead of their
// proposal. Staff never saw it — a preview opens with the proposal already in
// the store, so the early return never fires.
//
// Every test here holds the proposal back until the session check has answered,
// which is the order that broke.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider, useStore } from '../src/store.jsx';
import { PublicClientShell } from '../src/components/PublicClientShell.jsx';
import { ClientView } from '../src/components/ClientView.jsx';
import { ErrorBoundary } from '../src/components/ErrorBoundary.jsx';
import { DEFAULT_PROPOSAL, makeContentCreditTemplate, makeMonthlyPlanTemplate } from '../src/defaults.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;
const ID = 'prop_race';

const proposalFrom = (template) => ({
  ...JSON.parse(JSON.stringify(template)),
  clientName: 'Testshire University',
  proposalTitle: 'Animated explainer',
  // The public read ships the voiceover sample with the proposal.
  _voiceoverSample: null,
});

const PROPOSAL_TYPES = [
  ['standard', proposalFrom(DEFAULT_PROPOSAL)],
  ['Monthly Plan', proposalFrom(makeMonthlyPlanTemplate(DEFAULT_PROPOSAL))],
  ['Content Credit', proposalFrom(makeContentCreditTemplate(DEFAULT_PROPOSAL))],
];

const reply = (status, body) => Promise.resolve({
  status,
  ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body),
});

// Answers the session check at once (nobody signed in) and holds the proposal
// until release() — the order a client's browser usually sees.
function stubRequests(proposal) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (path === '/api/auth/me') return reply(401, { error: 'Not signed in' });
    if (path === '/api/proposals/' + ID) return gate.then(() => reply(200, proposal));
    if (path.startsWith('/api/signatures/') || path.startsWith('/api/payments/')) {
      return reply(404, { error: 'Not found' });
    }
    return reply(200, {});   // view tracking, example posters
  }));
  return () => release();
}

// Let every pending request chain, and the renders it triggers, finish.
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

let container;
let root;
let consoleErrors;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  consoleErrors = [];
  // React reports a caught render error through console.error; keep the output
  // clean and hold on to it so a failure can say what React objected to.
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const crashed = () => container.querySelector('[role="alert"]');
const hookErrors = () => consoleErrors.filter((m) => /Rendered (more|fewer) hooks|change in the order of Hooks/.test(m));

function expectProposalShown() {
  expect(crashed()?.textContent ?? null, 'the error boundary caught a crash').toBeNull();
  expect(hookErrors()).toEqual([]);
  expect(container.textContent).toContain('Prepared for');
  expect(container.textContent).toContain('Testshire University');
}

describe('a client opening their proposal link', () => {
  it('waits for the proposal rather than saying it was not found', async () => {
    const release = stubRequests(proposalFrom(DEFAULT_PROPOSAL));
    await act(async () => {
      root.render(h(ErrorBoundary, null, h(StoreProvider, null, h(PublicClientShell, { proposalId: ID }))));
    });
    await settle();   // the session check has answered; the proposal hasn't

    expect(container.textContent).not.toContain('Proposal not found');
    expect(container.textContent).toContain('Loading proposal');

    release();
    await settle();
    expectProposalShown();
  });

  it.each(PROPOSAL_TYPES)('opens a %s proposal instead of crashing', async (_type, proposal) => {
    const release = stubRequests(proposal);
    await act(async () => {
      root.render(h(ErrorBoundary, null, h(StoreProvider, null, h(PublicClientShell, { proposalId: ID }))));
    });
    await settle();
    release();
    await settle();
    expectProposalShown();
  });
});

// The same arrival order with the proposal view mounted from the start, as the
// CRM does when a preview link is opened before the proposals list has loaded.
// This pins the view's own hook order, independent of whatever its host does
// about waiting.
function LoadsLate({ id }) {
  const { actions } = useStore();
  React.useEffect(() => { actions.loadPublicProposal(id); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return h(ClientView, { id, onBack: null, useRealStripe: true });
}

describe('the proposal view', () => {
  it.each(PROPOSAL_TYPES)('keeps its hooks in order when a %s proposal arrives after it mounted', async (_type, proposal) => {
    const release = stubRequests(proposal);
    await act(async () => {
      root.render(h(ErrorBoundary, null, h(StoreProvider, null, h(LoadsLate, { id: ID }))));
    });
    await settle();
    expect(container.textContent).toContain('Proposal not found');   // the early return really did fire

    release();
    await settle();
    expectProposalShown();
  });

  it('still puts a Monthly Plan client on their plan when the proposal arrives late', async () => {
    const release = stubRequests(proposalFrom(makeMonthlyPlanTemplate(DEFAULT_PROPOSAL)));
    await act(async () => {
      root.render(h(ErrorBoundary, null, h(StoreProvider, null, h(LoadsLate, { id: ID }))));
    });
    await settle();
    release();
    await settle();
    expectProposalShown();

    // Signing is the opt-in, so the button prices the plan's first month (1
    // minute at the template's £300) rather than an empty £0 project.
    const signButton = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Accept & Sign'));
    expect(signButton?.textContent).toContain('£300.00 first month');
  });
});
