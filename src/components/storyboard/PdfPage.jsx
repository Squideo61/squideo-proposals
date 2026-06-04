import React, { useEffect, useRef, useState } from 'react';
import { BRAND } from '../../theme.js';
import { loadPdf } from '../../lib/pdf.js';

// Renders a single PDF page to a <canvas> fit to the container width, with an
// absolutely-positioned overlay for anchored comment pins. When `onPlacePin` is
// supplied the page is clickable: a click reports the click position as
// normalized [0,1] coordinates so the caller can anchor a comment to that spot.
//
// Props:
//   url          PDF blob URL
//   pageNumber   1-based slide to render
//   pins         [{ id, x, y, label, active }] normalized pin positions
//   onPlacePin   (x, y) => void   — enables click-to-pin when present
//   onPinClick   (id) => void
//   draftPin     { x, y } | null  — a not-yet-saved pin being placed
//   maxHeight    optional CSS max-height for the rendered page
export function PdfPage({ url, pageNumber, pins = [], onPlacePin, onPinClick, draftPin = null, maxHeight }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [width, setWidth] = useState(0);

  // Track the container width so we can render the page crisply at its display size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth || 0);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!url || !width) return;
    setStatus('loading');
    (async () => {
      try {
        const doc = await loadPdf(url);
        if (cancelled) return;
        const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const base = page.getViewport({ scale: 1 });
        const scale = (width / base.width) * dpr;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch { /* noop */ } }
        const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (!cancelled) setStatus('ready');
      } catch (err) {
        if (!cancelled && err?.name !== 'RenderingCancelledException') setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch { /* noop */ } }
    };
  }, [url, pageNumber, width]);

  function handleOverlayClick(e) {
    if (!onPlacePin) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    onPlacePin(Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5);
  }

  const allPins = draftPin ? [...pins, { id: '__draft__', x: draftPin.x, y: draftPin.y, draft: true }] : pins;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', maxHeight, margin: '0 auto', lineHeight: 0 }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', borderRadius: 6, background: '#fff' }} />
      {status === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: BRAND.muted, fontSize: 13, lineHeight: 1.4 }}>
          Loading slide…
        </div>
      )}
      {status === 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: BRAND.muted, fontSize: 13, lineHeight: 1.4 }}>
          Could not render this slide.
        </div>
      )}
      {/* Pin + click layer */}
      <div
        onClick={handleOverlayClick}
        style={{ position: 'absolute', inset: 0, cursor: onPlacePin ? 'crosshair' : 'default' }}
      >
        {allPins.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={(e) => { e.stopPropagation(); if (!p.draft && onPinClick) onPinClick(p.id); }}
            title={p.label != null ? String(p.label) : undefined}
            style={{
              position: 'absolute',
              left: `${p.x * 100}%`, top: `${p.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: 24, height: 24, padding: 0, borderRadius: '50%',
              background: p.draft ? '#F59E0B' : (p.active ? '#16A34A' : BRAND.blue),
              color: '#fff', fontSize: 11, fontWeight: 700,
              border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
              cursor: p.draft ? 'default' : 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            }}
          >
            {p.draft ? '' : (p.label ?? '')}
          </button>
        ))}
      </div>
    </div>
  );
}
