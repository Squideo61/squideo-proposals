// Org-level documents: brand guidelines (logos, fonts, tone-of-voice) and
// general documents. Per-project docs live on each project page.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, FileRow, SectionHeading } from '../components.jsx';
import { Palette, Upload, FolderOpen } from 'lucide-react';

function UploadZone({ onFiles, uploading, label }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(Array.from(e.dataTransfer.files || [])); }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${drag ? BRAND.blue : BRAND.border}`,
        background: drag ? BRAND.blue + '0d' : '#FAFBFC',
        borderRadius: 12, padding: '26px 16px', textAlign: 'center', cursor: 'pointer',
        transition: 'all 0.15s ease',
      }}
    >
      <Upload size={22} color={drag ? BRAND.blue : BRAND.muted} />
      <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginTop: 8 }}>
        {uploading ? 'Uploading…' : label}
      </div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
        Drag & drop or click — PDF, docs, images, fonts, zips (max 20 MB each)
      </div>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        disabled={uploading}
        onChange={(e) => { onFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
      />
    </div>
  );
}

export default function Documents() {
  const { companyId, showToast } = usePortal();
  const [files, setFiles] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState('brand'); // 'brand' | 'document'

  const load = useCallback(async () => {
    if (!companyId) return;
    const data = await portalApi.get(`files?companyId=${encodeURIComponent(companyId)}`);
    setFiles(data.files || []);
  }, [companyId]);

  useEffect(() => { load().catch((err) => showToast(err.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (list) => {
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list.slice(0, 10)) {
        // eslint-disable-next-line no-await-in-loop
        await portalApi.upload(`files?companyId=${encodeURIComponent(companyId)}&category=${tab}`, file);
      }
      showToast('Uploaded ✓ — our team can see it now');
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id) => {
    try {
      await portalApi.delete(`files?id=${encodeURIComponent(id)}`);
      await load();
    } catch (err) {
      showToast(err.message);
    }
  };

  const visible = (files || []).filter((f) => (f.category || 'brand') === tab);
  const tabStyle = (active) => ({
    padding: '8px 16px', borderRadius: 999, border: 'none', cursor: 'pointer',
    fontSize: 13, fontWeight: 700,
    background: active ? BRAND.ink : '#F1F4F7',
    color: active ? '#fff' : BRAND.muted,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Documents & brand</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13.5, color: BRAND.muted }}>
          Share your brand guidelines and documents once — our whole team uses them across every project.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={tabStyle(tab === 'brand')} onClick={() => setTab('brand')}>
          <Palette size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Brand guidelines
        </button>
        <button style={tabStyle(tab === 'document')} onClick={() => setTab('document')}>
          <FolderOpen size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Documents
        </button>
      </div>

      <Card>
        <UploadZone
          onFiles={upload}
          uploading={uploading}
          label={tab === 'brand' ? 'Upload brand guidelines, logos or fonts' : 'Upload a document'}
        />
        <div style={{ marginTop: 18 }}>
          {files === null ? (
            <div style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', padding: 10 }}>Loading…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              title={tab === 'brand' ? 'No brand files yet' : 'No documents yet'}
              body={tab === 'brand'
                ? 'Logos, fonts, colour palettes, tone-of-voice docs — anything that helps us nail your brand.'
                : 'Anything else you want our team to have on hand.'}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visible.map((f) => (
                <FileRow
                  key={f.id}
                  filename={f.filename}
                  sizeBytes={f.sizeBytes}
                  createdAt={f.createdAt}
                  meta={f.uploadedByName ? `by ${f.uploadedByName}` : null}
                  onDownload={() => { window.location.href = `/api/portal/download?scope=company&id=${encodeURIComponent(f.id)}`; }}
                  onDelete={() => remove(f.id)}
                />
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
