import React, { useState } from 'react';
import { BookmarkPlus, Building2, Check, ChevronLeft, CreditCard, Eye, Lightbulb, List, Package, Plus, PoundSterling, Save, Star, Users, Video, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { useIsMobile } from '../utils.js';
import { Field, Modal, Section } from './ui.jsx';
import { LogoUploader } from './LogoUploader.jsx';
import { TeamMemberEditor } from './TeamMemberEditor.jsx';
import { ExtrasBankManager } from './ExtrasBankManager.jsx';
import { InclusionsBankManager } from './InclusionsBankManager.jsx';

function SectionStatus({ issues }) {
  if (!issues || issues.length === 0) return (
    <span style={{ fontSize: 11, color: '#15803d', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 3 }}>
      <Check size={11} strokeWidth={3} /> Complete
    </span>
  );
  return (
    <span style={{ fontSize: 11, color: '#92400E', fontWeight: 700, background: '#FEF3C7', padding: '2px 8px', borderRadius: 10, border: '1px solid #FDE68A' }}>
      {issues.length} required
    </span>
  );
}

export function BuilderView({ id, onBack, onPreview, onSaveAsTemplate }) {
  const { state, actions, showMsg } = useStore();
  const data = state.proposals[id];
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const [showBankPicker, setShowBankPicker] = useState(false);
  const [showBankManager, setShowBankManager] = useState(false);
  const [showInclusionsPicker, setShowInclusionsPicker] = useState(false);
  const [showInclusionsManager, setShowInclusionsManager] = useState(false);

  const isMobile = useIsMobile();

  if (!data) {
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        Proposal not found.
        <div style={{ marginTop: 16 }}><button onClick={onBack} className="btn-ghost">Back</button></div>
      </div>
    );
  }

  const update = (patch) => {
    actions.saveProposal(id, { ...data, ...patch });
  };

  const updateTeam = (i, patch) => {
    const arr = [...data.team];
    arr[i] = { ...arr[i], ...patch };
    update({ team: arr });
  };

  const updateExtra = (i, patch) => {
    const arr = [...data.optionalExtras];
    arr[i] = { ...arr[i], ...patch };
    update({ optionalExtras: arr });
  };

  // Validation — required fields per section
  const issues = {
    client: [
      !data.clientName?.trim() && 'Client name',
      !data.contactBusinessName?.trim() && 'Business name',
    ].filter(Boolean),
    vision: [
      !data.requirement?.trim() && 'Requirement',
    ].filter(Boolean),
    pricing: [
      !(data.basePrice > 0) && 'Base price must be greater than 0',
    ].filter(Boolean),
  };
  const totalIssues = Object.values(issues).flat().length;

  const proposalLabel = [data.clientName, data.contactBusinessName].filter(Boolean).join(' · ') || 'New Proposal';

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? 12 : 24 }}>

      {/* ── Sticky header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 24, position: 'sticky', top: 0, background: BRAND.paper,
        padding: '12px 0', zIndex: 10, borderBottom: '1px solid ' + BRAND.border,
        flexWrap: 'wrap', gap: 8,
      }}>
        <button onClick={onBack} className="btn-ghost" style={{ flexShrink: 0 }}>
          <ChevronLeft size={16} /> Back
        </button>

        {!isMobile && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flex: 1, minWidth: 0, padding: '0 12px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
              {proposalLabel}
            </div>
            {totalIssues > 0 ? (
              <div style={{ fontSize: 11, color: '#92400E', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                ⚠ {totalIssues} field{totalIssues !== 1 ? 's' : ''} incomplete
              </div>
            ) : (
              <div style={{ fontSize: 11, color: '#15803d', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Check size={10} strokeWidth={3} /> Ready to send · auto-saved
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {!isMobile && (
            <button onClick={() => { setTplName(data.contactBusinessName ? data.contactBusinessName + ' template' : ''); setShowSaveTpl(true); }} className="btn-ghost">
              <Save size={14} /> Save as template
            </button>
          )}
          <button onClick={onPreview} className="btn"><Eye size={14} /> Preview</button>
        </div>
      </div>

      {/* ── Client Details ── */}
      <Section title="Client Details" color="#0369a1" icon={Building2} badge={<SectionStatus issues={issues.client} />}>
        <Field label="Client name" error={!data.clientName?.trim()}>
          <input className="input" value={data.clientName} onChange={(e) => update({ clientName: e.target.value })} placeholder="e.g. John Smith" />
        </Field>
        <Field label="Business name" error={!data.contactBusinessName?.trim()}>
          <input className="input" value={data.contactBusinessName} onChange={(e) => update({ contactBusinessName: e.target.value })} placeholder="e.g. Acme Ltd" />
        </Field>
        <Field label="Proposal title (optional)">
          <input className="input" value={data.proposalTitle || ''} onChange={(e) => update({ proposalTitle: e.target.value })} placeholder="Explainer Video Proposal" />
        </Field>
        <Field label="Client logo (optional)">
          <LogoUploader logo={data.clientLogo} onChange={(logo) => update({ clientLogo: logo })} showMsg={showMsg} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <Field label="Date">
            <input className="input" value={data.date} onChange={(e) => update({ date: e.target.value })} />
          </Field>
          <Field label="Prepared by">
            <input className="input" value={data.preparedBy} onChange={(e) => update({ preparedBy: e.target.value })} />
          </Field>
        </div>
        <Field label="Job title">
          <input className="input" value={data.preparedByTitle || ''} onChange={(e) => update({ preparedByTitle: e.target.value })} placeholder="e.g. Partnership Lead" />
        </Field>
      </Section>

      {/* ── Project Vision ── */}
      <Section title="Project Vision" color="#7c3aed" icon={Lightbulb} badge={<SectionStatus issues={issues.vision} />}>
        <Field label="Requirement" error={!data.requirement?.trim()}>
          <textarea
            rows={10}
            className="input"
            style={{ minHeight: isMobile ? 100 : 200, resize: 'vertical' }}
            value={data.requirement}
            onChange={(e) => update({ requirement: e.target.value })}
            placeholder={"1 x HD Animated explainer video - up to 60 seconds\n1 x Short social cutdown - 15 seconds"}
          />
        </Field>
        <Field label="Vision (problem and solution)">
          <textarea className="input" style={{ minHeight: 100 }} value={data.projectVision} onChange={(e) => update({ projectVision: e.target.value })} placeholder="Describe the problem and how the videos will solve it…" />
        </Field>
      </Section>

      {/* ── Delivery Team ── */}
      <Section title="Delivery Team" color="#0f766e" icon={Users}>
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '0 0 16px' }}>Photos appear on the client proposal.</p>
        {data.team.map((m, i) => (
          <TeamMemberEditor
            key={i}
            member={m}
            onChange={(p) => updateTeam(i, p)}
            onRemove={() => update({ team: data.team.filter((_, idx) => idx !== i) })}
            showMsg={showMsg}
          />
        ))}
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, marginBottom: 12, display: 'flex', gap: 14, alignItems: 'center', background: BRAND.paper, opacity: 0.85 }}>
          <img src="/team-photos/producers.png" alt="Production Team" style={{ width: 100, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Our Producers <span style={{ fontWeight: 400, color: BRAND.muted, fontSize: 11 }}>(always included)</span></div>
            <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4, lineHeight: 1.4 }}>Our experienced producers will be involved throughout the production process…</div>
          </div>
        </div>
        <button onClick={() => update({ team: [...data.team, { name: 'New Member', role: 'Role', bio: '', photo: null }] })} className="btn-ghost">
          <Plus size={14} /> Add team member
        </button>
      </Section>

      {/* ── Production Process ── */}
      <Section title="Production Process" color="#c2410c" icon={Video}>
        <Field label="Video URL">
          <input
            className="input"
            value={data.processVideoUrl || ''}
            onChange={(e) => update({ processVideoUrl: e.target.value })}
            placeholder="YouTube or Vimeo URL — leave blank to hide this section"
          />
        </Field>
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '4px 0 0' }}>Paste a YouTube or Vimeo link. The section will only appear on the proposal if a URL is set.</p>
      </Section>

      {/* ── Pricing ── */}
      <Section title="Pricing" color="#15803d" icon={PoundSterling} badge={<SectionStatus issues={issues.pricing} />}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <Field label="Base price (ex VAT)" error={!(data.basePrice > 0)}>
            <input type="number" className="input" value={data.basePrice} onChange={(e) => update({ basePrice: parseFloat(e.target.value) || 0 })} />
          </Field>
          <Field label="VAT rate (%)">
            <input type="number" step="1" className="input" value={Math.round(data.vatRate * 100)} onChange={(e) => update({ vatRate: (parseFloat(e.target.value) || 0) / 100 })} />
          </Field>
        </div>
        {data.basePrice > 0 && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#15803d', fontWeight: 600 }}>
            Total inc. VAT: £{(data.basePrice * (1 + data.vatRate)).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        )}
      </Section>

      {/* ── Payment Options ── */}
      <Section title="Payment Options" color="#1d4ed8" icon={CreditCard}>
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '0 0 12px' }}>Select which payment options are available to the client. At least one must be selected.</p>
        {(() => {
          const subtitlesPrice = data.optionalExtras.find(e => e.id === 'subtitles')?.price ?? 125;
          const currentOpts = data.paymentOptions || ['5050', 'full'];
          return [
            { key: '5050', label: '50/50 split', desc: '50% deposit to start, balance invoiced on final approval' },
            { key: 'full', label: 'Pay in full', desc: `Pay upfront via card or BACS — includes free subtitled version (worth £${subtitlesPrice}) · auto updates to match the pricing in optional extras` },
            { key: 'po', label: 'Purchase Order', desc: 'Client raises a PO — Squideo invoices against it' },
          ].map(({ key, label, desc }) => {
            const enabled = currentOpts.includes(key);
            return (
              <div key={key} style={{ borderBottom: '1px solid ' + BRAND.border }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', cursor: 'pointer', fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => {
                      const next = e.target.checked ? [...currentOpts, key] : currentOpts.filter(k => k !== key);
                      if (next.length > 0) update({ paymentOptions: next });
                    }}
                    style={{ marginTop: 3 }}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{desc}</div>
                  </div>
                </label>
                {key === 'full' && enabled && (
                  <div style={{ paddingLeft: 26, paddingBottom: 10 }}>
                    <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 4 }}>Custom incentive text (optional)</div>
                    <input
                      className="input"
                      style={{ fontSize: 13 }}
                      value={data.paymentOptionDescs?.full || ''}
                      placeholder={`get a free subtitled version (worth £${subtitlesPrice})`}
                      onChange={(e) => update({ paymentOptionDescs: { ...data.paymentOptionDescs, full: e.target.value } })}
                    />
                    <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>Leave blank to use the auto-generated text. Replaces the incentive shown to the client.</div>
                  </div>
                )}
              </div>
            );
          });
        })()}
      </Section>

      {/* ── What's Included ── */}
      <Section title="What's Included" color="#0e7490" icon={List}>
        {data.baseInclusions.map((inc, i) => (
          <div key={i} style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={inc.title}
                onChange={(e) => {
                  const arr = [...data.baseInclusions];
                  arr[i] = { ...inc, title: e.target.value };
                  update({ baseInclusions: arr });
                }}
                placeholder="Inclusion title"
              />
              <button
                onClick={() => {
                  const bank = state.inclusionsBank;
                  if (bank.some(b => b.title === inc.title)) { showMsg('Already in inclusions bank'); return; }
                  actions.saveInclusionsBank([...bank, { id: 'incl_' + Date.now(), title: inc.title, description: inc.description || '' }]);
                  showMsg('Saved to inclusions bank');
                }}
                aria-label="Save to bank"
                className="btn-icon"
                title="Save to inclusions bank"
              ><BookmarkPlus size={14} /></button>
              <button onClick={() => update({ baseInclusions: data.baseInclusions.filter((_, idx) => idx !== i) })} aria-label="Remove inclusion" className="btn-icon"><X size={14} /></button>
            </div>
            <textarea
              className="input"
              style={{ minHeight: 50, fontSize: 13 }}
              value={inc.description || ''}
              onChange={(e) => {
                const arr = [...data.baseInclusions];
                arr[i] = { ...inc, description: e.target.value };
                update({ baseInclusions: arr });
              }}
              placeholder="Description shown to client (optional)"
            />
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => update({ baseInclusions: [...data.baseInclusions, { title: 'New inclusion', description: '' }] })} className="btn-ghost">
            <Plus size={14} /> Add inclusion
          </button>
          <button onClick={() => setShowInclusionsPicker(p => !p)} className="btn-ghost">
            <BookmarkPlus size={14} /> Add from bank
          </button>
          <button onClick={() => setShowInclusionsManager(true)} className="btn-ghost">
            <BookmarkPlus size={14} /> Manage bank
          </button>
        </div>
        {showInclusionsPicker && (() => {
          const alreadyIn = new Set(data.baseInclusions.map(inc => inc.title));
          const available = state.inclusionsBank.filter(b => !alreadyIn.has(b.title));
          return (
            <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, marginTop: 12, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', background: BRAND.paper, borderBottom: '1px solid ' + BRAND.border, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Inclusions Bank</span>
                <button onClick={() => setShowInclusionsPicker(false)} className="btn-icon"><X size={14} /></button>
              </div>
              {available.length === 0 ? (
                <div style={{ padding: 16, fontSize: 13, color: BRAND.muted, textAlign: 'center' }}>
                  All bank inclusions are already on this proposal.
                </div>
              ) : available.map(item => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{item.title || '(untitled)'}</div>
                    {item.description && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{item.description}</div>}
                  </div>
                  <button
                    onClick={() => {
                      update({ baseInclusions: [...data.baseInclusions, { title: item.title, description: item.description }] });
                      showMsg('Added: ' + (item.title || 'inclusion'));
                    }}
                    className="btn"
                    style={{ fontSize: 12, padding: '4px 10px' }}
                  >Add</button>
                </div>
              ))}
            </div>
          );
        })()}
      </Section>

      {/* ── Partner Programme ── */}
      <Section title="Partner Programme" color="#b45309" icon={Star}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, cursor: 'pointer' }}>
          <input type="checkbox" checked={data.partnerProgramme.enabled} onChange={(e) => update({ partnerProgramme: { ...data.partnerProgramme, enabled: e.target.checked } })} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Show Partner Programme on this proposal</span>
        </label>
        {data.partnerProgramme.enabled && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
              <Field label="Monthly price (ex VAT)">
                <input type="number" className="input" value={data.partnerProgramme.price} onChange={(e) => update({ partnerProgramme: { ...data.partnerProgramme, price: parseFloat(e.target.value) || 0 } })} />
              </Field>
              <Field label="Project discount (%)">
                <input type="number" className="input" min="0" max="100" value={((data.partnerProgramme.discountRate || 0) * 100).toFixed(0)} onChange={(e) => update({ partnerProgramme: { ...data.partnerProgramme, discountRate: (parseFloat(e.target.value) || 0) / 100 } })} />
              </Field>
            </div>
            <Field label="Description">
              <textarea className="input" style={{ minHeight: 60 }} value={data.partnerProgramme.description} onChange={(e) => update({ partnerProgramme: { ...data.partnerProgramme, description: e.target.value } })} />
            </Field>
          </>
        )}
      </Section>

      {/* ── Optional Extras ── */}
      <Section title="Optional Extras" color="#be185d" icon={Package}>
        {data.optionalExtras.map((extra, i) => (
          <div key={extra.id} style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input className="input" style={{ flex: 1 }} value={extra.label} onChange={(e) => updateExtra(i, { label: e.target.value })} />
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: BRAND.muted, pointerEvents: 'none' }}>£</span>
                <input type="number" className="input" style={{ width: 90, paddingLeft: 22 }} value={extra.price} onChange={(e) => updateExtra(i, { price: parseFloat(e.target.value) || 0 })} />
              </div>
              <button
                onClick={() => {
                  const bank = state.extrasBank;
                  if (bank.some(b => b.id === extra.id)) { showMsg('Already in extras bank'); return; }
                  actions.saveExtrasBank([...bank, extra]);
                  showMsg('Saved to extras bank');
                }}
                aria-label="Save to bank"
                className="btn-icon"
                title="Save to extras bank"
              ><BookmarkPlus size={14} /></button>
              <button onClick={() => update({ optionalExtras: data.optionalExtras.filter((_, idx) => idx !== i) })} aria-label="Remove extra" className="btn-icon"><X size={14} /></button>
            </div>
            <textarea className="input" style={{ minHeight: 50, fontSize: 13 }} value={extra.description || ''} onChange={(e) => updateExtra(i, { description: e.target.value })} placeholder="Description shown to client" />
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => update({ optionalExtras: [...data.optionalExtras, { id: 'extra_' + Date.now(), label: 'New extra', price: 0, description: '' }] })} className="btn-ghost">
            <Plus size={14} /> Add extra
          </button>
          <button onClick={() => setShowBankPicker(p => !p)} className="btn-ghost">
            <BookmarkPlus size={14} /> Add from bank
          </button>
          <button onClick={() => setShowBankManager(true)} className="btn-ghost">
            <BookmarkPlus size={14} /> Manage bank
          </button>
        </div>
        {showBankPicker && (() => {
          const alreadyIn = new Set(data.optionalExtras.map(e => e.id));
          const available = state.extrasBank.filter(b => !alreadyIn.has(b.id));
          return (
            <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, marginTop: 12, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', background: BRAND.paper, borderBottom: '1px solid ' + BRAND.border, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Extras Bank</span>
                <button onClick={() => setShowBankPicker(false)} className="btn-icon"><X size={14} /></button>
              </div>
              {available.length === 0 ? (
                <div style={{ padding: 16, fontSize: 13, color: BRAND.muted, textAlign: 'center' }}>
                  All bank extras are already on this proposal.
                </div>
              ) : available.map(item => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{item.label || '(untitled)'}</div>
                    {item.description && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{item.description}</div>}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>£{item.price}</span>
                  <button
                    onClick={() => {
                      update({ optionalExtras: [...data.optionalExtras, { ...item }] });
                      showMsg('Added: ' + (item.label || 'extra'));
                    }}
                    className="btn"
                    style={{ fontSize: 12, padding: '4px 10px' }}
                  >Add</button>
                </div>
              ))}
            </div>
          );
        })()}
      </Section>

      {showBankManager && <ExtrasBankManager onClose={() => setShowBankManager(false)} />}
      {showInclusionsManager && <InclusionsBankManager onClose={() => setShowInclusionsManager(false)} />}

      {showSaveTpl && (
        <Modal onClose={() => setShowSaveTpl(false)}>
          <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>Save as template</h3>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted }}>Saves team, pricing, inclusions and extras. Client info is excluded.</p>
          <input
            autoFocus
            className="input"
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
            placeholder="e.g. NHS / SMB / Standard 60s"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tplName.trim()) {
                onSaveAsTemplate(data, tplName.trim());
                setShowSaveTpl(false);
              }
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => setShowSaveTpl(false)} className="btn-ghost">Cancel</button>
            <button onClick={() => { if (tplName.trim()) { onSaveAsTemplate(data, tplName.trim()); setShowSaveTpl(false); } }} className="btn">
              Save
            </button>
          </div>
        </Modal>
      )}

      {/* Mobile: save-as-template accessible from bottom */}
      {isMobile && (
        <button
          onClick={() => { setTplName(data.contactBusinessName ? data.contactBusinessName + ' template' : ''); setShowSaveTpl(true); }}
          className="btn-ghost"
          style={{ width: '100%', justifyContent: 'center', marginBottom: 32 }}
        >
          <Save size={14} /> Save as template
        </button>
      )}
    </div>
  );
}
