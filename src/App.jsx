import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { BRAND, APP_MAX_WIDTH } from './theme.js';
import { DEFAULT_PROPOSAL } from './defaults.js';
import { StoreProvider, useStore } from './store.jsx';
import { makeId } from './utils.js';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { Toast } from './components/ui.jsx';
import { AuthScreen } from './components/AuthScreen.jsx';
import { ClientView } from './components/ClientView.jsx';
import { PublicClientShell } from './components/PublicClientShell.jsx';
import { RevisionShell } from './components/revision/RevisionShell.jsx';
import { TemplatePicker } from './components/TemplatePicker.jsx';
import { NotificationBell } from './components/NotificationBell.jsx';
import { DesktopNotifier } from './components/DesktopNotifier.jsx';
import { CrmTopBar } from './components/crm/CrmTopBar.jsx';

const lazyNamed = (loader, name) => lazy(() => loader().then((m) => ({ default: m[name] })));

// Focused editor / public-facing views that should NOT show the CRM top bar.
const NO_TOPBAR_VIEWS = new Set(['builder', 'template-builder', 'client']);
// Board views that read better edge-to-edge — they opt out of the centred
// max-width cap and stay full width (their columns/rows can use the room).
const FULL_WIDTH_VIEWS = new Set(['pipeline', 'production']);

const ListView = lazyNamed(() => import('./components/ListView.jsx'), 'ListView');
const BuilderView = lazyNamed(() => import('./components/BuilderView.jsx'), 'BuilderView');
const TemplatesView = lazyNamed(() => import('./components/TemplatesView.jsx'), 'TemplatesView');
const LeaderboardView = lazyNamed(() => import('./components/LeaderboardView.jsx'), 'LeaderboardView');
const PartnerCreditsView = lazyNamed(() => import('./components/PartnerCreditsView.jsx'), 'PartnerCreditsView');
const PartnerCreditDetailView = lazyNamed(() => import('./components/PartnerCreditDetailView.jsx'), 'PartnerCreditDetailView');
const AdminView = lazyNamed(() => import('./components/admin/AdminView.jsx'), 'AdminView');
const AccountSettings = lazyNamed(() => import('./components/AccountSettings.jsx'), 'AccountSettings');
const PipelineView = lazyNamed(() => import('./components/crm/PipelineView.jsx'), 'PipelineView');
const DealDetailView = lazyNamed(() => import('./components/crm/DealDetailView.jsx'), 'DealDetailView');
const EmailComposerHost = lazyNamed(() => import('./components/crm/DealDetailView.jsx'), 'EmailComposerHost');
const ContactsView = lazyNamed(() => import('./components/crm/ContactsView.jsx'), 'ContactsView');
const ContactDetailView = lazyNamed(() => import('./components/crm/ContactDetailView.jsx'), 'ContactDetailView');
const CompanyDetailView = lazyNamed(() => import('./components/crm/CompanyDetailView.jsx'), 'CompanyDetailView');
const TasksView = lazyNamed(() => import('./components/crm/TasksView.jsx'), 'TasksView');
const EmailsView = lazyNamed(() => import('./components/crm/EmailsView.jsx'), 'EmailsView');
const QuoteRequestsView = lazyNamed(() => import('./components/crm/QuoteRequestsView.jsx'), 'QuoteRequestsView');
const XeroDuplicatesView = lazyNamed(() => import('./components/crm/XeroDuplicatesView.jsx'), 'XeroDuplicatesView');
const RevisionsView = lazyNamed(() => import('./components/crm/RevisionsView.jsx'), 'RevisionsView');
const StoryboardsView = lazyNamed(() => import('./components/crm/StoryboardsView.jsx'), 'StoryboardsView');
// Lazy so pdf.js (~300 kB) only loads when a storyboard is actually opened.
const StoryboardShell = lazyNamed(() => import('./components/storyboard/StoryboardShell.jsx'), 'StoryboardShell');
const ProductionView = lazyNamed(() => import('./components/crm/ProductionView.jsx'), 'ProductionView');
const VideoDetailView = lazyNamed(() => import('./components/crm/VideoDetailView.jsx'), 'VideoDetailView');
const ProjectsOverviewView = lazyNamed(() => import('./components/crm/ProjectsOverviewView.jsx'), 'ProjectsOverviewView');
const FinanceView = lazyNamed(() => import('./components/crm/FinanceView.jsx'), 'FinanceView');

function ViewFallback() {
  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontSize: 14, color: BRAND.muted }}>Loading…</div>
    </div>
  );
}

function parseHash() {
  const raw = window.location.hash.slice(2); // drop '#/'
  if (!raw) return { view: 'list', activeId: null };
  const sep = raw.indexOf('/');
  if (sep === -1) return { view: raw, activeId: null };
  return { view: raw.slice(0, sep), activeId: decodeURIComponent(raw.slice(sep + 1)) || null };
}

function buildHash(view, id) {
  if (view === 'list') return '#/';
  return '#/' + view + (id ? '/' + encodeURIComponent(id) : '');
}

function AppShell() {
  const { state, actions, showMsg, toast } = useStore();
  const user = state.session;
  // "Producer" (and "Copywriter", same scope for now) accounts are limited to
  // the production board, the project (deal) pages they work on, and the
  // Revisions section — no sales/admin nav.
  const producerOnly = user?.role === 'producer' || user?.role === 'copywriter';
  const [view, setView] = useState(() => parseHash().view);
  const [activeId, setActiveId] = useState(() => parseHash().activeId);
  const [modal, setModal] = useState(null);

  // Count of in-app pushState navigations this session, so "Back" can step
  // through real history (returning wherever the user came from) and only fall
  // back to an explicit target when there's no in-app history (e.g. a deep link).
  const navDepthRef = useRef(0);

  useEffect(() => {
    const onPop = () => {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      const { view: v, activeId: id } = parseHash();
      setView(v);
      setActiveId(id);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // CRM-wide undo/redo keyboard shortcuts. Skip while typing in a field or a
  // contentEditable so the browser's own text undo keeps working there.
  useEffect(() => {
    const isEditable = (el) => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y') return;
      if (isEditable(e.target)) return;
      const redo = (e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y';
      e.preventDefault();
      if (redo) actions.redo(); else actions.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions]);

  const navigate = useCallback((newView, newId = null) => {
    window.history.pushState(null, '', buildHash(newView, newId));
    navDepthRef.current += 1;
    setView(newView);
    setActiveId(newId);
  }, []);

  // History-aware back: returns to the previous in-app view, or `fallbackView`
  // if the current page was opened directly (no prior in-app history).
  const goBack = useCallback((fallbackView = 'list') => {
    if (navDepthRef.current > 0) window.history.back();
    else navigate(fallbackView);
  }, [navigate]);

  // Navigate from an in-app notification's hash link (e.g. '#/admin/users',
  // '#/deal/<id>'). Mirrors parseHash but works off the supplied string.
  const openLink = useCallback((link) => {
    if (!link) return;
    const raw = String(link).replace(/^#?\/?/, '');
    if (!raw) { navigate('list'); return; }
    const sep = raw.indexOf('/');
    if (sep === -1) navigate(raw);
    else navigate(raw.slice(0, sep), decodeURIComponent(raw.slice(sep + 1)) || null);
  }, [navigate]);

  if (state.loading) {
    return (
      <div style={{ minHeight: '100vh', background: BRAND.paper, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: BRAND.muted }}>Loading…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink }}>
        <AuthScreen />
        <Toast msg={toast} />
      </div>
    );
  }

  const createNew = () => {
    const tpls = Object.values(state.templates);
    if (tpls.length === 0) createFrom(DEFAULT_PROPOSAL);
    else setModal({ type: 'templates' });
  };

  // Same as createNew but pre-links the new proposal to a deal so the builder
  // lands populated with the deal's contact + company (see createFrom).
  const createForDeal = (dealId) => {
    const tpls = Object.values(state.templates);
    if (tpls.length === 0) createFrom(DEFAULT_PROPOSAL, { dealId });
    else setModal({ type: 'templates', dealId });
  };

  // Create a proposal pre-linked to an existing deal, pre-filling client and
  // company from the deal so the builder isn't blank.
  const createFrom = (base, { dealId } = {}) => {
    const id = makeId();
    const copy = JSON.parse(JSON.stringify(base));
    delete copy.id;
    delete copy.name;
    delete copy._number;
    delete copy._views;
    delete copy._createdAt;

    // When linking to a deal, pull contact + company names off the deal so
    // the builder lands populated. Falls back to blanks when the deal hasn't
    // got a contact/company yet.
    let prefillClient = '';
    let prefillBusiness = '';
    if (dealId) {
      const deal = state.deals[dealId];
      const contact = deal?.primaryContactId ? state.contacts[deal.primaryContactId] : null;
      const company = deal?.companyId ? state.companies[deal.companyId] : null;
      prefillClient = contact?.name || '';
      prefillBusiness = company?.name || deal?.title || '';
    }

    const data = {
      ...copy,
      clientName: prefillClient,
      contactBusinessName: prefillBusiness,
      clientLogo: null,
      projectVision: '',
      preparedBy: user.name || 'Adam Shelton',
      preparedByEmail: user.email || null,
      date: new Date().toLocaleDateString('en-GB'),
      createdAt: Date.now()
    };
    if (dealId) data._dealId = dealId;
    // Default the Partner Programme monthly rate to 20% off the project base price.
    if (data.partnerProgramme && typeof data.basePrice === 'number') {
      data.partnerProgramme = {
        ...data.partnerProgramme,
        price: Math.round(data.basePrice * 0.8 * 100) / 100,
      };
    }
    actions.saveProposal(id, data);
    navigate('builder', id);
    setModal(null);
  };

  const saveAsTemplate = (data, name) => {
    const id = makeId();
    const tpl = JSON.parse(JSON.stringify(data));
    tpl.name = name;
    tpl.createdAt = Date.now();
    delete tpl.clientName;
    delete tpl.contactBusinessName;
    delete tpl.clientLogo;
    delete tpl.projectVision;
    delete tpl._number;
    delete tpl._views;
    delete tpl._createdAt;
    actions.saveTemplate(id, tpl);
    showMsg('Template saved: ' + name);
  };

  const createTemplate = () => {
    const id = makeId();
    const tpl = JSON.parse(JSON.stringify(DEFAULT_PROPOSAL));
    delete tpl.clientName;
    delete tpl.contactBusinessName;
    delete tpl.clientLogo;
    delete tpl.projectVision;
    tpl.name = 'New template';
    tpl.createdAt = Date.now();
    actions.saveTemplate(id, tpl);
    navigate('template-builder', id);
  };

  const editTemplate = (id) => {
    navigate('template-builder', id);
  };

  const deleteProposal = (id) => {
    // Deleting a proposal never touches Xero — reversing money or voiding an
    // invoice is a deliberate call, not something delete should do silently.
    // The only path that voids the linked invoice is "Unmark as accepted",
    // which is offered while the proposal is accepted but unpaid. Warn
    // accordingly so the admin knows the invoice is left untouched.
    const signed = state.signatures[id];
    const payment = state.payments[id];
    let message = 'Delete this proposal?';
    if (signed && payment) {
      message = 'Delete this signed and paid proposal?\n\nThe linked Xero invoice will stay in Xero as PAID — it will NOT be voided or refunded. If you need to reverse the payment, do that in Xero manually.';
    } else if (signed) {
      message = 'Delete this accepted proposal?\n\nDeleting it here will NOT void the associated invoice. If you want the invoice voided, cancel and choose "Unmark as accepted" first (that voids the linked Xero invoice), then delete.';
    }
    if (!confirm(message)) return;
    actions.deleteProposal(id);
  };

  const duplicateProposal = (id) => {
    const source = state.proposals[id];
    if (!source) return;
    const newId = makeId();
    const copy = JSON.parse(JSON.stringify(source));
    delete copy.id;
    delete copy._number;
    delete copy._views;
    delete copy._createdAt;
    const data = {
      ...copy,
      preparedBy: user.name || copy.preparedBy || 'Adam Shelton',
      preparedByEmail: user.email || copy.preparedByEmail || null,
      date: new Date().toLocaleDateString('en-GB'),
      createdAt: Date.now(),
    };
    actions.saveProposal(newId, data);
    navigate('builder', newId);
    showMsg('Proposal duplicated');
  };

  const deleteTemplate = (id) => {
    if (!confirm('Delete this template?')) return;
    actions.deleteTemplate(id);
  };

  const logout = () => {
    actions.logout();
    navigate('list');
  };

  const templates = Object.entries(state.templates)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // Producers get a stripped shell: the production board by default, the
  // project (deal) pages they open from it, and the Revisions section — no
  // sales pipeline, dashboard, or admin nav.
  if (producerOnly) {
    // The production board (the fall-through case) stays full width; the detail
    // pages a producer opens are centred at the cap like the rest of the app.
    const producerBoard = !((view === 'video' && activeId) || ((view === 'project' || view === 'deal') && activeId) || view === 'projects' || view === 'revisions' || view === 'storyboards' || view === 'tasks');
    return (
      <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink }}>
        <DesktopNotifier onOpenLink={openLink} />
        {/* Trimmed top bar: logo + Tasks + notification bells + Account. No
            Sales/Business/Projects nav — producers stay scoped to production. */}
        <CrmTopBar
          producer
          view={view}
          fullWidth={producerBoard}
          navigate={navigate}
          onManageAccount={() => setModal({ type: 'account' })}
          onOpenLink={openLink}
        />
        <div style={producerBoard ? undefined : { maxWidth: APP_MAX_WIDTH, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <Suspense fallback={<ViewFallback />}>
          {view === 'video' && activeId ? (
            <VideoDetailView videoId={activeId} onBack={() => goBack('production')} onOpenProject={(id) => navigate('project', id)} />
          ) : (view === 'project' || view === 'deal') && activeId ? (
            <DealDetailView dealId={activeId} productionOnly onBack={() => goBack('production')} onOpenVideo={(id) => navigate('video', id)} />
          ) : view === 'projects' ? (
            <ProjectsOverviewView onBack={() => navigate('production')} onOpenProject={(id) => navigate('project', id)} />
          ) : view === 'revisions' ? (
            <RevisionsView onBack={() => navigate('production')} />
          ) : view === 'storyboards' ? (
            <StoryboardsView onBack={() => navigate('production')} />
          ) : view === 'tasks' ? (
            <TasksView onBack={() => navigate('production')} onOpenDeal={(id) => navigate('deal', id)} />
          ) : (
            <ProductionView onBack={null} onOpenVideo={(id) => navigate('video', id)} onOpenProject={(id) => navigate('project', id)} onOpenProjects={() => navigate('projects')} />
          )}
        </Suspense>
        </div>
        {/* Email composer lives at the root so "Send email" from a production
            card's conversation panel works in the producer shell too. */}
        {state.composerContext && (
          <Suspense fallback={null}>
            <EmailComposerHost />
          </Suspense>
        )}
        {modal && modal.type === 'account' && (
          <Suspense fallback={null}>
            <AccountSettings onClose={() => setModal(null)} onLogout={logout} />
          </Suspense>
        )}
        <Toast msg={toast} />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink }}>
      <DesktopNotifier onOpenLink={openLink} />
      {!NO_TOPBAR_VIEWS.has(view) && (
        <CrmTopBar
          view={view}
          fullWidth={FULL_WIDTH_VIEWS.has(view)}
          navigate={navigate}
          onManageAccount={() => setModal({ type: 'account' })}
          onOpenLink={openLink}
        />
      )}
      <div style={(NO_TOPBAR_VIEWS.has(view) || FULL_WIDTH_VIEWS.has(view)) ? undefined : { maxWidth: APP_MAX_WIDTH, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <Suspense fallback={<ViewFallback />}>
      {view === 'list' && (
        <ListView
          onCreate={createNew}
          onOpen={(id) => navigate('builder', id)}
          onPreview={(id) => navigate('client', id)}
          onDelete={deleteProposal}
          onDuplicate={duplicateProposal}
          onManageTemplates={() => navigate('templates')}
          onOpenDeal={(id) => navigate('deal', id)}
        />
      )}
      {view === 'admin' && (
        <AdminView
          tab={activeId || 'users'}
          onBack={() => navigate('list')}
          onChangeTab={(tab) => navigate('admin', tab)}
        />
      )}
      {view === 'pipeline' && (
        <PipelineView
          onBack={() => navigate('list')}
          onOpenDeal={(id) => navigate('deal', id)}
        />
      )}
      {(view === 'deal' || view === 'project') && activeId && (
        <DealDetailView
          dealId={activeId}
          onBack={() => goBack(view === 'project' ? 'projects' : 'pipeline')}
          onOpenProposal={(id, signed) => navigate(signed ? 'client' : 'builder', id)}
          onCreateProposal={createForDeal}
          onOpenVideo={(id) => navigate('video', id)}
          onOpenCompany={(id) => navigate('company', id)}
        />
      )}
      {view === 'contacts' && (
        <ContactsView
          onBack={() => navigate('list')}
          onOpenContact={(id) => navigate('contact', id)}
          onOpenCompany={(id) => navigate('company', id)}
          onManageXeroDuplicates={() => navigate('xero-duplicates')}
        />
      )}
      {view === 'contact' && activeId && (
        <ContactDetailView
          contactId={activeId}
          onBack={() => navigate('contacts')}
          onOpenDeal={(id) => navigate('deal', id)}
          onOpenCompany={(id) => navigate('company', id)}
        />
      )}
      {view === 'company' && activeId && (
        <CompanyDetailView
          companyId={activeId}
          onBack={() => navigate('contacts')}
          onOpenDeal={(id) => navigate('deal', id)}
          onOpenContact={(id) => navigate('contact', id)}
        />
      )}
      {view === 'tasks' && (
        <TasksView
          onBack={() => navigate('list')}
          onOpenDeal={(id) => navigate('deal', id)}
        />
      )}
      {(view === 'emails' || view === 'triage') && (
        <EmailsView
          folder={view === 'triage' ? 'triage' : (activeId || 'inbox')}
          onBack={() => navigate('list')}
          onOpenDeal={(id) => navigate('deal', id)}
          onSelectFolder={(f) => navigate('emails', f)}
        />
      )}
      {view === 'quote-requests' && (
        <QuoteRequestsView
          onBack={() => navigate('list')}
          onOpenDeal={(id) => navigate('deal', id)}
          onOpenContact={(id) => navigate('contact', id)}
        />
      )}
      {view === 'revisions' && (
        <RevisionsView onBack={() => navigate('list')} />
      )}
      {view === 'storyboards' && (
        <StoryboardsView onBack={() => navigate('list')} />
      )}
      {view === 'production' && (
        <ProductionView
          onBack={() => navigate('list')}
          onOpenVideo={(id) => navigate('video', id)}
          onOpenProject={(id) => navigate('project', id)}
          onOpenProjects={() => navigate('projects')}
        />
      )}
      {view === 'projects' && (
        <ProjectsOverviewView
          onBack={() => navigate('production')}
          onOpenProject={(id) => navigate('project', id)}
        />
      )}
      {view === 'video' && activeId && (
        <VideoDetailView
          videoId={activeId}
          onBack={() => goBack('production')}
          onOpenProject={(id) => navigate('project', id)}
        />
      )}
      {view === 'leaderboard' && (
        <LeaderboardView onBack={() => navigate('list')} />
      )}
      {/* Performance is now folded into Finance; keep the old route as an alias. */}
      {(view === 'finance' || view === 'performance') && (
        <FinanceView onBack={() => navigate('list')} onOpenDeal={(id) => navigate('deal', id)} onOpenCompany={(id) => navigate('company', id)} onOpenPartner={(key) => navigate('partner-credit-detail', key)} />
      )}
      {view === 'xero-duplicates' && (
        <XeroDuplicatesView onBack={() => navigate('list')} />
      )}
      {view === 'partner-credits' && (
        <PartnerCreditsView
          onBack={() => navigate('list')}
          onOpen={(clientKey) => navigate('partner-credit-detail', clientKey)}
        />
      )}
      {view === 'partner-credit-detail' && activeId && (
        <PartnerCreditDetailView
          clientKey={activeId}
          onBack={() => navigate('partner-credits')}
        />
      )}
      {view === 'templates' && (
        <TemplatesView
          onBack={() => navigate('list')}
          onUse={(t) => createFrom(t)}
          onEdit={editTemplate}
          onCreate={createTemplate}
          onDelete={deleteTemplate}
        />
      )}
      {view === 'builder' && activeId && (
        <BuilderView
          id={activeId}
          onBack={() => navigate('list')}
          onPreview={() => navigate('client', activeId)}
          onSaveAsTemplate={saveAsTemplate}
        />
      )}
      {view === 'template-builder' && activeId && (
        <BuilderView
          id={activeId}
          mode="template"
          onBack={() => navigate('templates')}
        />
      )}
      {view === 'client' && activeId && (
        <ClientView
          id={activeId}
          onBack={() => navigate('list')}
        />
      )}
      </Suspense>
      </div>
      {modal && modal.type === 'templates' && (
        <TemplatePicker templates={templates} onPick={(t) => createFrom(t || DEFAULT_PROPOSAL, { dealId: modal.dealId })} onClose={() => setModal(null)} />
      )}
      {modal && modal.type === 'account' && (
        <Suspense fallback={null}>
          <AccountSettings onClose={() => setModal(null)} onLogout={logout} />
        </Suspense>
      )}
      {/* The composer dock is mounted at the App root so it stays open
          while the user navigates around the CRM. The host returns null
          when state.composerContext is clear, so this is free when no
          email is being composed. */}
      {state.composerContext && (
        <Suspense fallback={null}>
          <EmailComposerHost />
        </Suspense>
      )}
      {/* The top bar hosts the bell on CRM views; on the focused editor /
          public views (no top bar) keep the floating bell so it's never lost. */}
      {NO_TOPBAR_VIEWS.has(view) && <NotificationBell onOpenLink={openLink} />}
      <Toast msg={toast} />
    </div>
  );
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const proposalId = params.get('proposal');
  if (proposalId) {
    return (
      <ErrorBoundary>
        <StoreProvider>
          <PublicClientShell proposalId={proposalId} />
        </StoreProvider>
      </ErrorBoundary>
    );
  }

  // ?revision= is the current public link param; ?review= is still accepted so
  // any links shared before the rename keep working.
  const revisionToken = params.get('revision') || params.get('review');
  if (revisionToken) {
    return (
      <ErrorBoundary>
        <StoreProvider>
          <RevisionShell token={revisionToken} />
        </StoreProvider>
      </ErrorBoundary>
    );
  }

  // ?storyboard= is the public link for a storyboard (PDF) review.
  const storyboardToken = params.get('storyboard');
  if (storyboardToken) {
    return (
      <ErrorBoundary>
        <StoreProvider>
          <Suspense fallback={<ViewFallback />}>
            <StoryboardShell token={storyboardToken} />
          </Suspense>
        </StoreProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <StoreProvider>
        <AppShell />
      </StoreProvider>
    </ErrorBoundary>
  );
}
