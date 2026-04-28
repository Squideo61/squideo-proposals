import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { BRAND, CONFIG, DEFAULT_PHOTOS } from '../theme.js';
import { resizeImage, useIsMobile } from '../utils.js';

export function TeamMemberEditor({ member, onChange, onRemove, showMsg }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const isMobile = useIsMobile();

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showMsg && showMsg('Please upload an image.');
      return;
    }
    if (file.size > CONFIG.limits.maxImageBytes) {
      showMsg && showMsg('Image too large — max ' + Math.round(CONFIG.limits.maxImageBytes / 1024 / 1024) + ' MB.');
      return;
    }
    setBusy(true);
    try {
      const url = await resizeImage(file, 200, 200, false);
      onChange({ photo: url });
      setBusy(false);
    } catch {
      showMsg && showMsg('Image upload failed.');
      setBusy(false);
    }
  };

  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, marginBottom: 12, display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div style={{ flexShrink: 0 }}>
        {(() => {
          const displayPhoto = member.photo || DEFAULT_PHOTOS[member.name];
          return displayPhoto ? (
            <div style={{ position: 'relative', width: 64, height: 64 }}>
              <img src={displayPhoto} alt={member.name} onClick={() => fileRef.current && fileRef.current.click()} style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', border: '2px solid ' + BRAND.blue, cursor: 'pointer' }} />
              {member.photo && (
                <button onClick={() => onChange({ photo: null })} aria-label="Remove photo" style={{ position: 'absolute', top: -4, right: -4, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#D32F2F', color: 'white', cursor: 'pointer', fontSize: 12 }}>×</button>
              )}
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current && fileRef.current.click()} aria-label="Upload team member photo" style={{ width: 64, height: 64, borderRadius: '50%', background: BRAND.paper, border: '2px dashed ' + BRAND.border, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: BRAND.muted, fontSize: 11, textAlign: 'center', lineHeight: 1.2, padding: 4, fontFamily: 'inherit' }}>
              {busy ? '…' : 'Upload photo'}
            </button>
          );
        })()}
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8, marginBottom: 8 }}>
          <input className="input" style={{ flex: 1 }} value={member.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Name" />
          <input className="input" style={{ flex: 1.5 }} value={member.role} onChange={(e) => onChange({ role: e.target.value })} placeholder="Role" />
          <button onClick={onRemove} aria-label="Remove team member" className="btn-icon"><X size={14} /></button>
        </div>
        <textarea className="input" style={{ minHeight: 60, fontSize: 13 }} value={member.bio} onChange={(e) => onChange({ bio: e.target.value })} placeholder="Short bio shown under the photo" />
      </div>
    </div>
  );
}
