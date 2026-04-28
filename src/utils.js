import { useState, useEffect } from 'react';

export const makeId = () => 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

export function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth <= 640);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth <= 640);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mobile;
}

export const formatGBP = (n) => '£' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const formatProposalNumber = (n) =>
  n && n.year && n.seq ? n.year + '-' + String(n.seq).padStart(3, '0') : '';

export const formatRelativeTime = (iso) => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(iso).toLocaleDateString('en-GB');
};

export const formatDuration = (s) => {
  s = Math.max(0, Math.round(Number(s) || 0));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? m + 'm ' + r + 's' : m + 'm';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? h + 'h ' + mm + 'm' : h + 'h';
};

export function resizeImage(file, maxW, maxH, keepPng) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const isPng = keepPng && file.type === 'image/png';
        resolve(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.88));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function sendNotification(trigger, proposal, signature, payment, recipients) {
  if (!recipients || recipients.length === 0) return 0;
  const subject = trigger === 'signed'
    ? 'Proposal signed: ' + (proposal.contactBusinessName || proposal.clientName || 'Untitled')
    : 'Payment received: ' + (proposal.contactBusinessName || proposal.clientName);
  const body = trigger === 'signed'
    ? signature.name + ' just accepted the proposal for ' + formatGBP(signature.total)
    : 'Payment of ' + formatGBP(payment.amount) + ' received from ' + signature.name;
  console.log('[EMAIL STUB]', { to: recipients, subject, body });
  return recipients.length;
}
