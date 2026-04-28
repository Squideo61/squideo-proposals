import React, { useRef, useState } from 'react';
import { BRAND, CONFIG } from '../theme.js';
import { resizeImage } from '../utils.js';

export function LogoUploader({ logo, onChange, showMsg }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showMsg && showMsg('Please upload an image (PNG, JPG or SVG).');
      return;
    }
    if (file.size > CONFIG.limits.maxImageBytes) {
      showMsg && showMsg('Image too large — max ' + Math.round(CONFIG.limits.maxImageBytes / 1024 / 1024) + ' MB.');
      return;
    }
    setBusy(true);
    try {
      if (file.type === 'image/svg+xml') {
        const reader = new FileReader();
        reader.onload = (ev) => { onChange(ev.target.result); setBusy(false); };
        reader.readAsDataURL(file);
      } else {
        const url = await resizeImage(file, 600, 300, true);
        onChange(url);
        setBusy(false);
      }
    } catch {
      showMsg && showMsg('Logo upload failed.');
      setBusy(false);
    }
  };

  if (logo) {
    return (
      <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 16, background: BRAND.paper }}>
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, padding: 16, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 80 }}>
          <img src={logo} alt="Client logo" style={{ maxWidth: '100%', maxHeight: 100, objectFit: 'contain' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => fileRef.current && fileRef.current.click()} className="btn-ghost">Replace</button>
          <button onClick={() => onChange(null)} className="btn-ghost is-danger">Remove</button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={handleFile} style={{ display: 'none' }} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <button type="button" onClick={() => fileRef.current && fileRef.current.click()} style={{ width: '100%', border: '2px dashed ' + BRAND.border, borderRadius: 8, padding: 24, textAlign: 'center', cursor: 'pointer', background: BRAND.paper, color: BRAND.muted, fontSize: 13, fontFamily: 'inherit' }}>
        {busy ? 'Uploading…' : (
          <>
            <div style={{ fontWeight: 600, color: BRAND.ink, marginBottom: 4 }}>Click to upload client logo</div>
            <div style={{ fontSize: 11 }}>PNG, JPG or SVG · max 600 × 300px</div>
          </>
        )}
      </button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={handleFile} style={{ display: 'none' }} />
    </div>
  );
}
