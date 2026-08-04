// Pick a video's thumbnail from a still in the video itself, the way Vimeo does
// — scrub to the frame you want and grab it.
//
// The frame is drawn onto a canvas, which browsers refuse to read back from if
// the video came from another origin. Both callers stream their video via a 302
// to the blob host, so whoever mounts this must pass a SAME-ORIGIN `streamSrc`
// (the portal library uses its download route's &stream=1 relay) or the capture
// throws a security error on toDataURL.
//
// Used by the portal library (manage mode) and by Admin → Crash course.
// Storage is the caller's business: `onSave` receives a base64 JPEG data URL,
// or null when the admin clears the thumbnail.

import React, { useRef, useState } from 'react';
import { Camera } from 'lucide-react';

// 960 wide is plenty for a tile on a retina screen and keeps the stored JPEG
// around 100 KB — comfortably inside the 1MB the server accepts.
const CAPTURE_WIDTH = 960;
const JPEG_QUALITY = 0.78;

export function PosterPicker({ streamSrc, hasPoster, onSave, onClose, onError, dark = true }) {
  const videoRef = useRef(null);
  const [shot, setShot] = useState(null);
  const [busy, setBusy] = useState(false);

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const width = Math.min(v.videoWidth, CAPTURE_WIDTH);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round((v.videoHeight / v.videoWidth) * width);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    try {
      setShot(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
    } catch {
      onError("Couldn't read that frame — try reloading the page.");
    }
  };

  const save = async (poster) => {
    setBusy(true);
    try {
      await onSave(poster);
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  };

  const muted = dark ? '#B9CBD6' : '#6B7785';

  return (
    <div style={{ background: dark ? '#0F2A3D' : '#F4F7F9', padding: 10, borderRadius: 8 }}>
      {shot ? (
        <img src={shot} alt="Chosen thumbnail" style={{ width: '100%', display: 'block', borderRadius: 6 }} />
      ) : (
        <video
          ref={videoRef}
          controls
          preload="metadata"
          playsInline
          src={streamSrc}
          style={{ width: '100%', display: 'block', borderRadius: 6, background: '#000' }}
        />
      )}
      <div style={{ fontSize: 11.5, color: muted, margin: '8px 0', lineHeight: 1.45 }}>
        {shot ? 'Use this frame?' : 'Scrub to the frame you want, then grab it.'}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {shot ? (
          <>
            <button className="btn" onClick={() => save(shot)} disabled={busy} style={{ flex: 1 }}>
              {busy ? 'Saving…' : 'Use this frame'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => setShot(null)}
              disabled={busy}
              style={{ color: dark ? '#DCEEF7' : undefined, padding: '0 12px' }}
            >
              Pick another
            </button>
          </>
        ) : (
          <>
            <button
              className="btn"
              onClick={capture}
              style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              <Camera size={15} /> Grab this frame
            </button>
            {hasPoster && (
              <button
                className="btn-ghost"
                onClick={() => save(null)}
                disabled={busy}
                style={{ color: '#F5A3A3', padding: '0 12px' }}
              >
                Clear
              </button>
            )}
          </>
        )}
        <button
          className="btn-ghost"
          onClick={onClose}
          disabled={busy}
          style={{ color: muted, padding: '0 12px' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
