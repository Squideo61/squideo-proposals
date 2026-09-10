// @vitest-environment jsdom
//
// The deal page has to cope with its deal arriving after it opened.
//
// The CRM holds every page until its first load is in, so a deal on the list
// is there from the page's first render. Not every deal is: one created after
// this tab loaded (by a colleague, the quote form, the email auto-linker) and
// opened from a link isn't on the list, so the page opens on "Loading deal…"
// and fills in when the deal's own request lands. The page used to take that
// loading return itself, with hooks further down — so the render that brought
// the deal in called more hooks than the one before, and clicking from a loaded
// deal through to one still loading called fewer. React throws on both, and
// the page became "Something went wrong".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StoreProvider, useStore } from '../src/store.jsx';
import { DealDetailView } from '../src/components/crm/DealDetailView.jsx';
import { ErrorBoundary } from '../src/components/ErrorBoundary.jsx';
import { h, held, mountRoot, reply, settle } from './helpers/renderInDom.js';

const STAFF = { email: 'sam@squideo.co.uk', name: 'Sam Staff', role: 'admin', roleName: 'Admin', permissions: [] };

const dealDetail = (id, title) => ({
  id,
  title,
  stage: 'lead',
  value: null,
  ownerEmail: STAFF.email,
  companyId: null,
  primaryContactId: null,
  proposals: [],
  videos: [],
  events: [],
  tasks: [],
  emails: [],
  comments: [],
  secondaryContacts: [],
});

// Signed in. `listed` deals come back in the CRM's first load, so they're in
// the store before any page mounts; a `late` deal is only reachable through its
// own detail request, held until release(id).
function stubStaffRequests({ listed = [], late = {} }) {
  const onList = Object.fromEntries(listed.map((d) => [d.id, d]));
  const gates = new Map(Object.keys(late).map((id) => [id, held()]));
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (path === '/api/auth/me') return reply(200, { user: STAFF });
    if (path === '/api/crm/deals') return reply(200, listed);
    const detailId = decodeURIComponent(path.match(/^\/api\/crm\/deals\/([^/?]+)$/)?.[1] || '');
    if (onList[detailId]) return reply(200, onList[detailId]);
    if (gates.has(detailId)) return gates.get(detailId).gate.then(() => reply(200, late[detailId]));
    if (['/api/proposals', '/api/templates', '/api/settings', '/api/users'].includes(path)) return reply(200, {});
    if (path === '/api/crm/gmail') return reply(200, null);
    return reply(200, []);
  }));
  return (id) => gates.get(id).release();
}

// Holds the page until the CRM's first load is in, as the app shell does.
function AfterFirstLoad({ children }) {
  const { state } = useStore();
  return state.loading ? null : children;
}

const dealPage = (dealId) => h(ErrorBoundary, null,
  h(StoreProvider, null, h(AfterFirstLoad, null, h(DealDetailView, { dealId, onBack: () => {} }))));

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

function expectDealShown(title) {
  expectNoCrash();
  expect(view.container.textContent).toContain(title);
  expect(view.container.textContent).not.toContain('Loading deal');
}

describe('the deal page', () => {
  it('shows a deal created after the tab loaded, once it arrives', async () => {
    const release = stubStaffRequests({ late: { deal_new: dealDetail('deal_new', 'Testshire rebrand') } });
    await view.render(dealPage('deal_new'));
    await settle();
    expect(view.container.textContent).toContain('Loading deal');

    release('deal_new');
    await settle();
    expectDealShown('Testshire rebrand');
  });

  it('moves from a loaded deal to one still loading without crashing', async () => {
    const release = stubStaffRequests({
      listed: [dealDetail('deal_a', 'First deal')],
      late: { deal_b: dealDetail('deal_b', 'Second deal') },
    });
    await view.render(dealPage('deal_a'));
    await settle();
    expectDealShown('First deal');

    // The same page, handed a deal that isn't in yet — following a link from
    // one deal to a newer one.
    await view.render(dealPage('deal_b'));
    await settle();
    expectNoCrash();
    expect(view.container.textContent).toContain('Loading deal');

    release('deal_b');
    await settle();
    expectDealShown('Second deal');
  });
});
