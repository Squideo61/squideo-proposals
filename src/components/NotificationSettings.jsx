import React, { useState } from 'react';
import { Mail, Plus, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { sendNotification } from '../utils.js';
import { Modal } from './ui.jsx';

export function NotificationSettings({ onClose }) {
  const { state, actions, showMsg } = useStore();
  const recipients = state.notificationRecipients;
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState('');

  const add = () => {
    setError('');
    const e = newEmail.trim().toLowerCase();
    if (!e) return;
    if (!e.includes('@') || !e.includes('.')) {
      setError('Enter a valid email');
      return;
    }
    if (recipients.includes(e)) {
      setError('Already in the list');
      return;
    }
    actions.setNotificationRecipients([...recipients, e]);
    setNewEmail('');
  };

  const remove = (email) => {
    actions.setNotificationRecipients(recipients.filter(r => r !== email));
  };

  const test = async () => {
    if (recipients.length === 0) {
      showMsg('Add at least one recipient first.');
      return;
    }
    await sendNotification('signed',
      { contactBusinessName: 'TEST CLIENT', clientName: 'Test', preparedBy: 'You' },
      { name: 'Test Signer', email: 'test@example.com', signedAt: new Date().toISOString(), total: 1500, partnerTotal: 0, paymentOption: '5050' },
      null,
      recipients
    );
    showMsg('Test logged to console for ' + recipients.length + ' recipient' + (recipients.length === 1 ? '' : 's'));
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Notification recipients</h3>
        <button onClick={onClose} aria-label="Close" className="btn-icon"><X size={14} /></button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        These emails will be notified when proposals are <strong>signed</strong> or <strong>paid</strong>.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="adam@squideo.com"
        />
        <button onClick={add} className="btn"><Plus size={14} /> Add</button>
      </div>

      {error && (
        <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 12, padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {recipients.length === 0 ? (
        <div style={{ background: BRAND.paper, border: '1px dashed ' + BRAND.border, borderRadius: 8, padding: 24, textAlign: 'center', color: BRAND.muted, fontSize: 13, marginTop: 8 }}>
          No recipients yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
          {recipients.map((email) => (
            <div key={email} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6 }}>
              <Mail size={14} color={BRAND.muted} />
              <span style={{ flex: 1, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
              <button onClick={() => remove(email)} aria-label={'Remove ' + email} className="btn-icon is-danger" style={{ padding: 4 }}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {recipients.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button onClick={test} className="btn-ghost"><Mail size={14} /> Send test notification</button>
        </div>
      )}

      <div style={{ marginTop: 20, padding: 12, background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 6, fontSize: 11, color: '#8A6D00', lineHeight: 1.5 }}>
        <strong>Prototype:</strong> Test notifications log to browser console. Real emails need a backend with Resend or Postmark.
      </div>
    </Modal>
  );
}
