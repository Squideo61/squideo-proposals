import React, { useEffect, useRef, useState } from 'react';
import { BRAND } from '../../theme.js';
import { loadPdf } from '../../lib/pdf.js';

// Small fixed-width thumbnail of one PDF page, rendered to a <canvas>. Used for
// the slide rail in the public viewer and the first-page preview in the
// producer list.
export function PdfThumb({ url, pageNumber = 1, width = 120 }) {
  const canvasRef = useRef(null);
  const taskRef = useRef(null);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    if (!url) return;
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
        canvas.style.width = width + 'px';
        canvas.style.height = 'auto';
        if (taskRef.current) { try { taskRef.current.cancel(); } catch { /* noop */ } }
        const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        taskRef.current = task;
        await task.promise;
        if (!cancelled) setStatus('ready');
      } catch (err) {
        if (!cancelled && err?.name !== 'RenderingCancelledException') setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      if (taskRef.current) { try { taskRef.current.cancel(); } catch { /* noop */ } }
    };
  }, [url, pageNumber, width]);

  return (
    <div style={{ width, minHeight: 40, background: '#fff', borderRadius: 4, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <canvas ref={canvasRef} style={{ display: status === 'ready' ? 'block' : 'none', width }} />
      {status !== 'ready' && (
        <span style={{ color: BRAND.muted, fontSize: 10, padding: 8 }}>
          {status === 'error' ? '—' : '…'}
        </span>
      )}
    </div>
  );
}
