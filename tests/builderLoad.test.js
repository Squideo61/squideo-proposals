// @vitest-environment jsdom
//
// The proposal builder has to cope with its proposal coming and going while
// it's open.
//
// It reads its proposal from the store, which the CRM keeps in step with the
// server by re-reading the proposals list on a poll (and whenever the window
// regains focus). So the proposal can be missing on one render and there on
// the next — a builder link to one created after this tab loaded — or there and
// then gone, when a colleague deletes it while it's on screen. The builder
// shows "Proposal not found" while it's missing, and used to have hooks below
// that return: whichever render crossed it called a different number of hooks
// from the one before, which React refuses, and the builder became "Something
// went wrong".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { StoreProvider, useStore } from '../src/store.jsx';
import { BuilderView } from '../src/components/BuilderView.jsx';
import { ErrorBoundary } from '../src/components/ErrorBoundary.jsx';
import { DEFAULT_PROPOSAL } from '../src/defaults.js';
import { h, mountRoot, reply, settle } from './helpers/renderInDom.js';

const STAFF = { email: 'sam@squideo.co.uk', name: 'Sam Staff', role: 'admin', roleName: 'Admin', permissions: [] };

const PROPOSAL = {
  ...JSON.parse(JSON.stringify(DEFAULT_PROPOSAL)),
  clientName: 'Testshire University',
  contactBusinessName: 'Testshire Ltd',
};

// Signed in, with the proposals list answering from `server.proposals` — which
// a test changes to stand for a colleague creating or deleting one.
function stubStaffRequests(proposals) {
  const server = { proposals };
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (path === '/api/auth/me') return reply(200, { user: STAFF });
    if (path === '/api/proposals') return reply(200, server.proposals);
    if (['/api/templates', '/api/settings', '/api/users'].includes(path)) return reply(200, {});
    if (path === '/api/crm/gmail') return reply(200, null);
    return reply(200, []);
  }));
  return server;
}

// The window regaining focus runs the proposals poll straight away.
async function pollProposals() {
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await settle();
}

// Holds the page until the CRM's first load is in, as the app shell does.
function AfterFirstLoad({ children }) {
  const { state } = useStore();
  return state.loading ? null : children;
}

const builder = (id) => h(ErrorBoundary, null,
  h(StoreProvider, null, h(AfterFirstLoad, null,
    h(BuilderView, { id, onBack: () => {}, onPreview: () => {}, onSaveAsTemplate: () => {} }))));

let view;

beforeEach(() => { view = mountRoot(); });

afterEach(async () => {
  await view.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectNoCrash() {
  expect(view.crashText(), 'the error boundary caught a crash').toBeNull();
  expect(view.hookErrors()).toEqual([]);
}

describe('the proposal builder', () => {
  it('opens a proposal that turns up after the builder did', async () => {
    const server = stubStaffRequests({});   // not created yet when the tab loaded
    await view.render(builder('prop_b'));
    await settle();
    expect(view.container.textContent).toContain('Proposal not found');

    server.proposals = { prop_b: PROPOSAL };
    await pollProposals();
    expectNoCrash();
    expect(view.container.textContent).toContain('Testshire University · Testshire Ltd');
  });

  it('says "not found" when the proposal on screen is deleted elsewhere', async () => {
    const server = stubStaffRequests({ prop_b: PROPOSAL });
    await view.render(builder('prop_b'));
    await settle();
    expect(view.container.textContent).toContain('Testshire University · Testshire Ltd');

    server.proposals = {};
    await pollProposals();
    expectNoCrash();
    expect(view.container.textContent).toContain('Proposal not found');
  });
});
