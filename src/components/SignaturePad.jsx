import React, { useEffect, useRef, useState } from 'react';
import { PenLine, Upload, RotateCcw, Check } from 'lucide-react';
import { BRAND } from '../theme.js';

// DocuSign-style signature capture: the client either draws their signature on
// a canvas or uploads an image of it. Either way the result is emitted to the
// parent as a PNG data URL via onChange (null when cleared). Used alongside the
// typed full name on the proposal acceptance form.
export function SignaturePad({ value, onChange }) {
  const [mode, setMode] = useState('draw'); // 'draw' | 'upload'
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  const hasInkRef = useRef(false);
  const fileRef = useRef(null);

  // Size the canvas to its rendered box at the device pixel ratio so strokes
  // stay crisp. Re-run when entering draw mode (the canvas isn't mounted in
  // upload mode).
  useEffect(() => {
    if (mode !== 'draw') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const setup = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0F2A3D';
    };
    setup();
    window.addEventListener('resize', setup);
    return () => window.removeEventListener('resize', setup);
  }, [mode]);

  const pointFrom = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const src = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  };

  const startDraw = (e) => {
    e.preventDefault();
    drawingRef.current = true;
    lastRef.current = pointFrom(e);
  };
  const moveDraw = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFrom(e);
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    hasInkRef.current = true;
  };
  const endDraw = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (hasInkRef.current) onChange(canvasRef.current.toDataURL('image/png'));
  };

  const clearDraw = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    hasInkRef.current = false;
    onChange(null);
  };

  const onUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Downscale to a sensible max width so a phone photo doesn't bloat the
      // stored signature (it lives in the signature JSON). Re-encode as PNG.
      const img = new Image();
      img.onload = () => {
        const maxW = 600;
        const scale = img.width > maxW ? maxW / img.width : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        off.getContext('2d').drawImage(img, 0, 0, w, h);
        onChange(off.toDataURL('image/png'));
      };
      img.onerror = () => onChange(String(reader.result));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const switchMode = (next) => {
    if (next === mode) return;
    // Switching capture method clears whatever was there — a drawn canvas and
    // an uploaded file can't coexist, so reset to avoid a stale signature.
    onChange(null);
    hasInkRef.current = false;
    if (fileRef.current) fileRef.current.value = '';
    setMode(next);
  };

  const tabStyle = (active) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8,
    border: '1px solid ' + (active ? BRAND.blue : BRAND.border),
    background: active ? '#EFF8FC' : 'white', color: active ? BRAND.blue : BRAND.muted,
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button type="button" onClick={() => switchMode('draw')} style={tabStyle(mode === 'draw')}>
          <PenLine size={14} /> Draw
        </button>
        <button type="button" onClick={() => switchMode('upload')} style={tabStyle(mode === 'upload')}>
          <Upload size={14} /> Upload
        </button>
      </div>

      {mode === 'draw' ? (
        <div>
          <div style={{ position: 'relative', border: '1px dashed ' + BRAND.border, borderRadius: 8, background: 'white', overflow: 'hidden' }}>
            <canvas
              ref={canvasRef}
              style={{ display: 'block', width: '100%', height: 160, touchAction: 'none', cursor: 'crosshair' }}
              onMouseDown={startDraw}
              onMouseMove={moveDraw}
              onMouseUp={endDraw}
              onMouseLeave={endDraw}
              onTouchStart={startDraw}
              onTouchMove={moveDraw}
              onTouchEnd={endDraw}
            />
            {!value && (
              <span style={{ position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)', textAlign: 'center', color: BRAND.muted, fontSize: 13, pointerEvents: 'none' }}>
                Sign here with your mouse or finger
              </span>
            )}
          </div>
          <button type="button" onClick={clearDraw} className="btn-ghost" style={{ fontSize: 12, marginTop: 6 }}>
            <RotateCcw size={13} /> Clear
          </button>
        </div>
      ) : (
        <div>
          {value ? (
            <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, background: 'white', padding: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
              <img src={value} alt="Your signature" style={{ maxHeight: 120, maxWidth: '100%', objectFit: 'contain' }} />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#16A34A', fontSize: 12, fontWeight: 600, marginLeft: 'auto' }}>
                <Check size={14} /> Uploaded
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current && fileRef.current.click()}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', height: 120, border: '1px dashed ' + BRAND.border, borderRadius: 8, background: 'white', cursor: 'pointer', color: BRAND.muted, fontSize: 13, fontFamily: 'inherit' }}
            >
              <Upload size={20} />
              Upload an image of your signature
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" onChange={onUpload} style={{ display: 'none' }} />
          {value && (
            <button type="button" onClick={() => { if (fileRef.current) fileRef.current.value = ''; onChange(null); }} className="btn-ghost" style={{ fontSize: 12, marginTop: 6 }}>
              <RotateCcw size={13} /> Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
