import React, { useState, useEffect, useCallback } from 'react';
import { BRAND } from './theme.js';
import { DEFAULT_PROPOSAL } from './defaults.js';
import { StoreProvider, useStore } from './store.jsx';
import { makeId } from './utils.js';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { Toast } from './components/ui.jsx';
import { AuthScreen } from './components/AuthScreen.jsx';
import { ListView } from './components/ListView.jsx';
import { BuilderView } from './components/BuilderView.jsx';
import { ClientView } from './components/ClientView.jsx';
import { PublicClientShell } from './components/PublicClientShell.jsx';
import { TemplatePicker } from './components/TemplatePicker.jsx';
import { TemplatesView } from './components/TemplatesView.jsx';
import { LeaderboardView } from './components/LeaderboardView.jsx';
import { PartnerCreditsView } from './components/PartnerCreditsView.jsx';
import { PartnerCreditDetailView } from './components/PartnerCreditDetailView.jsx';
import { UserManager } from './components/UserManager.jsx';
import { NotificationSettings } from './components/NotificationSettings.jsx';
import { AccountSettings } from './components/AccountSettings.jsx';
import { PipelineView } from './components/crm/PipelineView.jsx';
import { DealDetailView } from './components/crm/DealDetailView.jsx';
import { ContactsView } from './components/crm/ContactsView.jsx';
import { TasksView } from './components/crm/TasksView.jsx';
import { TriageView } from './components/crm/TriageView.jsx';

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
  const [view, setView] = useState(() => parseHash().view);
  const [activeId, setActiveId] = useState(() => parseHash().activeId);
  const [modal, setModal] = useState(null);

  useEffect(() => {
    const onPop = () => {
      const { view: v, activeId: id } = parseHash();
      setView(v);
      setActiveId(id);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((newView, newId = null) => {
    window.history.pushState(null, '', buildHash(newView, newId));
    setView(newView);
    setActiveId(newId);
  }, []);

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

  const createFrom = (base) => {
    const id = makeId();
    const copy = JSON.parse(JSON.stringify(base));
    delete copy.id;
    delete copy.name;
    delete copy._number;
    delete copy._views;
    delete copy._createdAt;
    const data = {
      ...copy,
      clientName: '',
      contactBusinessName: '',
      clientLogo: null,
      projectVision: '',
      preparedBy: user.name || 'Adam Shelton',
      preparedByEmail: user.email || null,
      date: new Date().toLocaleDateString('en-GB'),
      createdAt: Date.now()
    };
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
    if (!confirm('Delete this proposal?')) return;
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

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink }}>
      {view === 'list' && (
        <ListView
          onCreate={createNew}
          onOpen={(id) => navigate('builder', id)}
          onPreview={(id) => navigate('client', id)}
          onDelete={deleteProposal}
          onDuplicate={duplicateProposal}
          onManageUsers={() => setModal({ type: 'users' })}
          onManageNotifications={() => setModal({ type: 'notifications' })}
          onManageAccount={() => setModal({ type: 'account' })}
          onManageTemplates={() => navigate('templates')}
          onManageLeaderboard={() => navigate('leaderboard')}
          onManagePartnerCredits={() => navigate('partner-credits')}
          onManagePipeline={() => navigate('pipeline')}
          onManageContacts={() => navigate('contacts')}
          onManageTasks={() => navigate('tasks')}
          onManageTriage={() => navigate('triage')}
        />
      )}
      {view === 'pipeline' && (
        <PipelineView
          onBack={() => navigate('list')}
          onOpenDeal={(id) => navigate('deal', id)}
        />
      )}
      {view === 'deal' && activeId && (
        <DealDetailView
          dealId={activeId}
          onBack={() => navigate('pipeline')}
          onOpenProposal={(id) => navigate('builder', id)}
        />
      )}
      {view === 'contacts' && (
        <ContactsView onBack={() => navigate('list')} />
      )}
      {view === 'tasks' && (
        <TasksView
          onBack={() => navigate('list')}
          onOpenDeal={(id) => navigate('deal', id)}
        />
      )}
      {view === 'triage' && (
        <TriageView
          onBack={() => navigate('list')}
          onOpenDeal={(id) => navigate('deal', id)}
        />
      )}
      {view === 'leaderboard' && (
        <LeaderboardView onBack={() => navigate('list')} />
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
      {modal && modal.type === 'templates' && (
        <TemplatePicker templates={templates} onPick={(t) => createFrom(t || DEFAULT_PROPOSAL)} onClose={() => setModal(null)} />
      )}
      {modal && modal.type === 'users' && (
        <UserManager onClose={() => setModal(null)} />
      )}
      {modal && modal.type === 'notifications' && (
        <NotificationSettings onClose={() => setModal(null)} />
      )}
      {modal && modal.type === 'account' && (
        <AccountSettings onClose={() => setModal(null)} onLogout={logout} />
      )}
      <Toast msg={toast} />
    </div>
  );
}

export default function App() {
  const proposalId = new URLSearchParams(window.location.search).get('proposal');
  if (proposalId) {
    return (
      <ErrorBoundary>
        <StoreProvider>
          <PublicClientShell proposalId={proposalId} />
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
