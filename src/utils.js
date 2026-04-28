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
