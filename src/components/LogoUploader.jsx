import React, { useRef, useState } from 'react';
import { BRAND, CONFIG } from '../theme.js';
import { resizeImage } from '../utils.js';

const ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp';

export function LogoUploader({ logo, onChange, showMsg }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  const takeFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showMsg && showMsg('Please upload an image (PNG, JPG, SVG or WEBP).');
      return;
    }
    if (file.size > CONFIG.limits.maxImageBytes) {
      showMsg && showMsg('Image too large — max ' + Math.round(CONFIG.limits.maxImageBytes / 1024 / 1024) + ' MB.');
      return;
    }
    setBusy(true);
    try {
      if (file.type === 'image/svg+xml') {
        // SVG is already resolution-independent — keep the original rather than
        // rasterising it onto a canvas.
        const reader = new FileReader();
        reader.onload = (ev) => { onChange(ev.target.result); setBusy(false); };
        reader.onerror = () => { showMsg && showMsg('Logo upload failed.'); setBusy(false); };
        reader.readAsDataURL(file);
      } else {
        // keepAlpha: PNG and WEBP keep their transparency (WEBP is re-encoded as
        // PNG, which every PDF and email client can render).
        const url = await resizeImage(file, 600, 300, true);
        onChange(url);
        setBusy(false);
      }
    } catch {
      showMsg && showMsg('Logo upload failed.');
      setBusy(false);
    }
  };

  // Shared drag handlers — dropping works whether or not a logo is already set,
  // so replacing one is the same gesture as adding the first.
  const dropProps = {
    onDragOver: (e) => { e.preventDefault(); setDrag(true); },
    onDragEnter: (e) => { e.preventDefault(); setDrag(true); },
    onDragLeave: (e) => { e.preventDefault(); setDrag(false); },
    onDrop: (e) => {
      e.preventDefault();
      setDrag(false);
      takeFile(e.dataTransfer?.files?.[0]);
    },
  };

  const pick = () => fileRef.current && fileRef.current.click();
  const input = (
    <input
      ref={fileRef}
      type="file"
      accept={ACCEPT}
      onChange={(e) => { takeFile(e.target.files && e.target.files[0]); e.target.value = ''; }}
      style={{ display: 'none' }}
    />
  );

  if (logo) {
    return (
      <div
        {...dropProps}
        style={{
          border: '1px solid ' + (drag ? BRAND.blue : BRAND.border),
          borderRadius: 8, padding: 16,
          background: drag ? BRAND.blue + '0d' : BRAND.paper,
          transition: 'all 0.15s ease',
        }}
      >
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, padding: 16, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 80 }}>
          <img src={logo} alt="Client logo" style={{ maxWidth: '100%', maxHeight: 100, objectFit: 'contain' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={pick} className="btn-ghost" disabled={busy}>{busy ? 'Uploading…' : 'Replace'}</button>
          <button onClick={() => onChange(null)} className="btn-ghost is-danger">Remove</button>
          <span style={{ fontSize: 11, color: BRAND.muted }}>
            {drag ? 'Drop to replace' : 'or drop a new one here'}
          </span>
          {input}
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={pick}
        {...dropProps}
        style={{
          width: '100%', border: '2px dashed ' + (drag ? BRAND.blue : BRAND.border), borderRadius: 8,
          padding: 24, textAlign: 'center', cursor: 'pointer',
          background: drag ? BRAND.blue + '0d' : BRAND.paper,
          color: BRAND.muted, fontSize: 13, fontFamily: 'inherit',
          transition: 'all 0.15s ease',
        }}
      >
        {busy ? 'Uploading…' : (
          <>
            <div style={{ fontWeight: 600, color: BRAND.ink, marginBottom: 4 }}>
              {drag ? 'Drop your logo here' : 'Drop a logo here, or click to choose'}
            </div>
            <div style={{ fontSize: 11 }}>PNG, JPG, SVG or WEBP · max 600 × 300px</div>
          </>
        )}
      </button>
      {input}
    </div>
  );
}
