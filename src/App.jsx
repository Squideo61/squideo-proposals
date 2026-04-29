import React, { useState } from 'react';
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
import { UserManager } from './components/UserManager.jsx';
import { NotificationSettings } from './components/NotificationSettings.jsx';
import { AccountSettings } from './components/AccountSettings.jsx';

function AppShell() {
  const { state, actions, showMsg, toast } = useStore();
  const user = state.session;
  const [view, setView] = useState('list');
  const [activeId, setActiveId] = useState(null);
  const [modal, setModal] = useState(null);

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
    actions.saveProposal(id, data);
    setActiveId(id);
    setView('builder');
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
    setActiveId(id);
    setView('template-builder');
  };

  const editTemplate = (id) => {
    setActiveId(id);
    setView('template-builder');
  };

  const deleteProposal = (id) => {
    if (!confirm('Delete this proposal?')) return;
    actions.deleteProposal(id);
  };

  const deleteTemplate = (id) => {
    if (!confirm('Delete this template?')) return;
    actions.deleteTemplate(id);
  };

  const logout = () => {
    actions.logout();
    setView('list');
    setActiveId(null);
  };

  const templates = Object.entries(state.templates)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink }}>
      {view === 'list' && (
        <ListView
          onCreate={createNew}
          onOpen={(id) => { setActiveId(id); setView('builder'); }}
          onPreview={(id) => { setActiveId(id); setView('client'); }}
          onDelete={deleteProposal}
          onLogout={logout}
          onManageUsers={() => setModal({ type: 'users' })}
          onManageNotifications={() => setModal({ type: 'notifications' })}
          onManageAccount={() => setModal({ type: 'account' })}
          onManageTemplates={() => setView('templates')}
          onManageLeaderboard={() => setView('leaderboard')}
        />
      )}
      {view === 'leaderboard' && (
        <LeaderboardView onBack={() => setView('list')} />
      )}
      {view === 'templates' && (
        <TemplatesView
          onBack={() => setView('list')}
          onUse={(t) => createFrom(t)}
          onEdit={editTemplate}
          onCreate={createTemplate}
          onDelete={deleteTemplate}
        />
      )}
      {view === 'builder' && activeId && (
        <BuilderView
          id={activeId}
          onBack={() => { setView('list'); setActiveId(null); }}
          onPreview={() => setView('client')}
          onSaveAsTemplate={saveAsTemplate}
        />
      )}
      {view === 'template-builder' && activeId && (
        <BuilderView
          id={activeId}
          mode="template"
          onBack={() => { setView('templates'); setActiveId(null); }}
        />
      )}
      {view === 'client' && activeId && (
        <ClientView
          id={activeId}
          onBack={() => { setView('list'); setActiveId(null); }}
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
        <AccountSettings onClose={() => setModal(null)} />
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
