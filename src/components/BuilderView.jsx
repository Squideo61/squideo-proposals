import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, Building2, Check, ChevronLeft, CreditCard, Eye, GripVertical, Lightbulb, List, Lock, Package, Plus, PoundSterling, Save, Star, Users, Video, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { useIsMobile, formatGBP, computeBaseDiscount } from '../utils.js';
import { Field, Modal, Section } from './ui.jsx';
import { LogoUploader } from './LogoUploader.jsx';
import { TeamMemberEditor } from './TeamMemberEditor.jsx';
import { ExtrasBankManager } from './ExtrasBankManager.jsx';
import { extraHasVariants, VARIANT_ELIGIBLE_IDS } from '../defaults.js';
import { InclusionsBankManager } from './InclusionsBankManager.jsx';
import { ClientLinkPanel } from './crm/ClientLinkPanel.jsx';

// Fetch a Vimeo video's title + thumbnail via our /api/vimeo-oembed proxy
// (the app CSP blocks calling vimeo.com from the browser). Returns
// { title, thumbnail } or null.
async function fetchVimeoMeta(url) {
  const clean = String(url || '').trim();
  if (!/vimeo\.com\/\d+/.test(clean)) return null;
  try {
    // Go through our same-origin proxy — the app CSP (connect-src 'self')
    // blocks fetching vimeo.com directly. The proxy forwards the full url so
    // unlisted videos keep their privacy hash (vimeo.com/ID/HASH).
    const res = await fetch('/api/vimeo-oembed?url=' + encodeURIComponent(clean));
    if (!res.ok) return null;
    const json = await res.json();
    return {
      title: json && json.title ? String(json.title) : null,
      thumbnail: json && json.thumbnail ? String(json.thumbnail) : null,
    };
  } catch {
    return null;
  }
}

function reorderArray(arr, from, to) {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function useReorderState() {
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  return {
    draggingIdx,
    overIdx,
    start: (i) => setDraggingIdx(i),
    over: (i) => setOverIdx(i),
    reset: () => { setDraggingIdx(null); setOverIdx(null); },
  };
}

function ukDateToISO(dateStr) {
  const m = String(dateStr || '').match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
  if (!m) return '';
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

function defaultExpiryISO(proposalDate, validityDays) {
  const base = ukDateToISO(proposalDate) || new Date().toISOString().slice(0, 10);
  const d = new Date(base);
  d.setDate(d.getDate() + (Number(validityDays) || 28));
  return d.toISOString().slice(0, 10);
}

function DragHandle({ onDragStart, onDragEnd }) {
  return (
    <span
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ cursor: 'grab', color: '#9CA3AF', display: 'flex', alignItems: 'center', flexShrink: 0, padding: '4px 2px' }}
      aria-label="Drag to reorder"
      title="Drag to reorder"
    >
      <GripVertical size={16} />
    </span>
  );
}

// Section metadata used to drive the mobile nav strip + collapsed-state hints.
// Order matches the rendering order in the JSX below; ids match the keys
// passed to sectionProps()/jumpToSection() throughout BuilderView.
function buildSectionMeta(data, isTemplate, issues, isDefault) {
  const formatGBPint = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  const truncate = (s, max = 60) => {
    if (!s) return '';
    const trimmed = String(s).trim();
    return trimmed.length > max ? trimmed.slice(0, max).trimEnd() + '…' : trimmed;
  };
  const list = [
    {
      id: 'client',
      label: isDefault ? 'Default' : isTemplate ? 'Template' : 'Client',
      hint: isDefault
        ? 'The base for every new proposal'
        : isTemplate
        ? data.name?.trim() || 'Untitled template'
        : [data.clientName, data.contactBusinessName].filter(s => s?.trim()).join(' · ') || 'Tap to fill in',
      hasIssues: (issues.client || []).length > 0,
    },
    {
      id: 'vision',
      label: 'Vision',
      hint: (data.videoOptions || []).length > 0 ? `${data.videoOptions.length} option${data.videoOptions.length === 1 ? '' : 's'}` : (truncate(data.requirement) || 'Empty'),
      hasIssues: (issues.vision || []).length > 0,
    },
    {
      id: 'team',
      label: 'Team',
      hint: `${(data.team || []).length} member${(data.team || []).length === 1 ? '' : 's'}`,
      hasIssues: false,
    },
    {
      id: 'process',
      label: 'Process',
      hint: data.processVideoUrl ? truncate(data.processVideoUrl, 50) : 'No process video',
      hasIssues: false,
    },
    {
      id: 'examples',
      label: 'Examples',
      hint: data.showNotableExamples
        ? `${(data.notableExamples || []).filter(e => e?.url?.trim()).length} example${(data.notableExamples || []).filter(e => e?.url?.trim()).length === 1 ? '' : 's'}`
        : 'Off',
      hasIssues: false,
    },
    {
      id: 'pricing',
      label: 'Pricing',
      hint: data.basePrice > 0 ? formatGBPint(data.basePrice) + ' + VAT' : 'Set a price',
      hasIssues: (issues.pricing || []).length > 0,
    },
    {
      id: 'payment',
      label: 'Payment',
      hint: (() => {
        const opts = data.paymentOptions || ['5050', 'full'];
        const map = { '5050': '50/50', full: 'Full', po: 'PO' };
        return opts.map(o => map[o] || o).join(', ') || 'No options';
      })(),
      hasIssues: false,
    },
    {
      id: 'inclusions',
      label: 'Included',
      hint: `${(data.baseInclusions || []).length} inclusion${(data.baseInclusions || []).length === 1 ? '' : 's'}`,
      hasIssues: false,
    },
    {
      id: 'partner',
      label: 'Partner',
      hint: data.partnerProgramme?.enabled
        ? `Enabled · ${Math.round((data.partnerProgramme.discountRate || 0) * 100)}%`
        : 'Disabled',
      hasIssues: false,
    },
    {
      id: 'extras',
      label: 'Extras',
      hint: `${(data.optionalExtras || []).length} extra${(data.optionalExtras || []).length === 1 ? '' : 's'}`,
      hasIssues: false,
    },
  ];
  // Content Credit proposals have no Partner Programme section, so it must not
  // appear in the mobile section nav either.
  const creditOnly = data.partnerProgramme?.mode === 'oneoff' && !!data.partnerProgramme?.creditOnly;
  return creditOnly ? list.filter(s => s.id !== 'partner') : list;
}

function PriceInput({ value, onChange, ...props }) {
  const [raw, setRaw] = useState(value == null ? '' : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setRaw(value == null ? '' : String(value));
  }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        const n = parseFloat(raw);
        const final = isNaN(n) ? 0 : n;
        setRaw(String(final));
        onChange(final);
      }}
      {...props}
    />
  );
}

// Optional manual discount on the project base price. Collapsed behind an
// "Add discount" button by default; auto-expands when a proposal already
// carries a discount. "Remove" clears it and collapses again.
function DiscountEditor({ basePrice, discount, onChange, isMobile }) {
  const d = discount || { type: 'percent', value: 0, label: '' };
  const value = Number(d.value) || 0;
  const [open, setOpen] = useState(value > 0);
  const setDiscount = (patch) => onChange({ ...d, ...patch });
  const isPct = d.type !== 'amount';
  const amount = computeBaseDiscount(basePrice, d);

  if (!open) {
    return (
      <button type="button" className="btn-ghost" style={{ marginTop: 4, alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        <Plus size={14} /> Add discount
      </button>
    );
  }

  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, padding: '12px 14px', marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Discount</div>
        <button
          type="button"
          className="btn-ghost"
          style={{ color: '#B91C1C', fontSize: 12, padding: '2px 8px' }}
          onClick={() => { onChange({ ...d, value: 0 }); setOpen(false); }}
        >
          <X size={13} /> Remove
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '130px 1fr', gap: 12 }}>
        <Field label="Type">
          <select className="input" value={isPct ? 'percent' : 'amount'} onChange={(e) => setDiscount({ type: e.target.value })}>
            <option value="percent">% off</option>
            <option value="amount">£ off</option>
          </select>
        </Field>
        <Field label={isPct ? 'Percentage off (%)' : 'Amount off (£, ex VAT)'}>
          <PriceInput min="0" step={isPct ? '1' : '0.01'} className="input" value={value} onChange={(n) => setDiscount({ value: n })} />
        </Field>
      </div>
      <Field label="Label shown on the proposal (optional)">
        <input className="input" value={d.label || ''} placeholder="e.g. Loyalty discount" onChange={(e) => setDiscount({ label: e.target.value })} />
      </Field>
      {value > 0 && basePrice > 0 && (
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
          Base {formatGBP(basePrice)} → <strong style={{ color: '#15803d' }}>{formatGBP(basePrice - amount)}</strong>
          {' '}({isPct ? `${value}% off` : `${formatGBP(amount)} off`}). Optional extras stay full price; ignored if the client opts into the Partner Programme.
        </div>
      )}
    </div>
  );
}

// Tier-ladder editor: base % + per-extra-credit % + cap, with a worked example.
// Shared by the Pricing section (Content Credit proposals, where the credit
// config IS the proposal) and the Partner Programme section (standard proposals).
function CreditTierFields({ pp, onChange }) {
  const baseD = pp.discountRate || 0;
  const extraD = pp.extraDiscountPerCredit || 0;
  const maxD = pp.maxDiscount || baseD;
  const tier = (n) => Math.min(baseD + Math.max(0, n - 1) * extraD, maxD);
  const fmtPct = (v) => (Math.round(v * 1000) / 10).toString().replace(/\.0$/, '');
  const samples = [1, 2, 3, 4].map(n => `${n} ${n === 1 ? 'min' : 'mins'} = ${fmtPct(tier(n))}%`);
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: '#6B7785', marginBottom: 4, fontWeight: 600 }}>Base (%)</div>
          <PriceInput
            className="input" min="0" max="100"
            value={((pp.discountRate || 0) * 100).toFixed(0)}
            onChange={(n) => onChange({ ...pp, discountRate: n / 100 })}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#6B7785', marginBottom: 4, fontWeight: 600 }}>Per extra credit (%)</div>
          <PriceInput
            className="input" min="0" max="100" step="0.5"
            value={((pp.extraDiscountPerCredit || 0) * 100).toFixed(2).replace(/\.?0+$/, '')}
            onChange={(n) => onChange({ ...pp, extraDiscountPerCredit: n / 100 })}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#6B7785', marginBottom: 4, fontWeight: 600 }}>Max (%)</div>
          <PriceInput
            className="input" min="0" max="100"
            value={((pp.maxDiscount || 0) * 100).toFixed(0)}
            onChange={(n) => onChange({ ...pp, maxDiscount: n / 100 })}
          />
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#6B7785', marginTop: 6, lineHeight: 1.5 }}>
        Worked example: {samples.join(' · ')}{tier(4) === maxD && extraD > 0 ? ' (capped)' : ''}.
      </div>
    </>
  );
}

// Live preview of what a minute of credit costs at each tier.
function CreditRatePreview({ pp, basePrice, suffix = '', note }) {
  const base = Number(pp?.standardRatePerMin) || Number(basePrice) || 0;
  const baseD = pp?.discountRate || 0;
  const extraD = pp?.extraDiscountPerCredit || 0;
  const maxD = pp?.maxDiscount || baseD;
  const tierRate = (n) => base * (1 - Math.min(baseD + Math.max(0, n - 1) * extraD, maxD));
  if (base <= 0) {
    return <div style={{ fontSize: 13, color: '#6B7785', padding: 8 }}>Set a standard rate per minute to compute the partner rate.</div>;
  }
  return (
    <div style={{ background: '#FFFAEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '10px 12px', fontSize: 13, lineHeight: 1.6 }}>
      <div style={{ color: '#0F2A3D' }}>
        <strong>1 min</strong>: £{tierRate(1).toFixed(0)}{suffix} &nbsp;·&nbsp;
        <strong>2 mins</strong>: £{tierRate(2).toFixed(0)}{suffix} &nbsp;·&nbsp;
        <strong>3 mins</strong>: £{tierRate(3).toFixed(0)}{suffix}
      </div>
      <div style={{ fontSize: 12, color: '#78350F', marginTop: 4 }}>{note}</div>
    </div>
  );
}

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

export function BuilderView({ id, onBack, onPreview, onSaveAsTemplate, mode }) {
  const { state, actions, showMsg } = useStore();
  // The default-proposal editor (Admin → Default proposal) reuses every bit of
  // template mode — client fields skipped, no "save as template", a Done button —
  // so isDefault piggybacks on isTemplate for UI, and only the data source,
  // the persistence target, and the header label differ.
  const isDefault = mode === 'default';
  const isTemplate = mode === 'template' || isDefault;
  const data = isDefault ? state.defaultProposal : (isTemplate ? state.templates[id] : state.proposals[id]);
  const signature = isTemplate ? null : state.signatures[id];
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const [showBankPicker, setShowBankPicker] = useState(false);
  const [showBankManager, setShowBankManager] = useState(false);
  const [showInclusionsPicker, setShowInclusionsPicker] = useState(false);
  const [showInclusionsManager, setShowInclusionsManager] = useState(false);
  const inclusionsReorder = useReorderState();
  const extrasReorder = useReorderState();
  const isMobile = useIsMobile();

  if (!data) {
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        {isTemplate ? 'Template' : 'Proposal'} not found.
        <div style={{ marginTop: 16 }}><button onClick={onBack} className="btn-ghost">Back</button></div>
      </div>
    );
  }

  const update = (patch) => {
    if (isDefault) {
      actions.saveDefaultProposal({ ...data, ...patch });
    } else if (isTemplate) {
      actions.saveTemplate(id, { ...data, ...patch });
    } else {
      actions.saveProposal(id, { ...data, ...patch });
    }
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

  const updateExample = (i, patch) => {
    const arr = [...(data.notableExamples || [])];
    arr[i] = { ...arr[i], ...patch };
    update({ notableExamples: arr });
  };

  // On blur of an example's URL, pull the Vimeo thumbnail (for the proposal's
  // clickable poster) and the title. Title is only filled when still blank so
  // we never clobber one the user has adjusted; the thumbnail always refreshes.
  const autofillExampleMeta = async (i, url) => {
    const meta = await fetchVimeoMeta(url);
    if (!meta) return;
    const current = (data.notableExamples || [])[i];
    if (!current) return;
    const patch = {};
    if (meta.thumbnail) patch.thumbnail = meta.thumbnail;
    if (meta.title && !(current.title && current.title.trim())) patch.title = meta.title;
    if (Object.keys(patch).length) updateExample(i, patch);
  };

  // £0 base price is allowed when the Partner Programme is enabled — lets us
  // give the first video free on a retainer sign-up. Otherwise a real price is
  // required so a £0 proposal can't go out by accident.
  // Credit-only proposals quote the deliverable as an amount of minutes priced
  // off the standard rate; the tier discount then applies only to the extra
  // minutes the client adds on the proposal itself.
  const isCreditOnly = !!(data.partnerProgramme?.enabled
    && data.partnerProgramme?.mode === 'oneoff'
    && data.partnerProgramme?.creditOnly);
  const creditRatePerMin = Number(data.partnerProgramme?.standardRatePerMin) || Number(data.basePrice) || 0;
  const minutesToPrice = (n) => Math.round((Number(n) || 0) * creditRatePerMin * 100) / 100;

  const basePriceOk = data.partnerProgramme?.enabled
    ? Number(data.basePrice) >= 0
    : Number(data.basePrice) > 0;

  // Validation — required fields per section (client fields skipped in template mode)
  const issues = {
    client: isTemplate ? [] : [
      !data.clientName?.trim() && 'Client name',
      !data.contactBusinessName?.trim() && 'Business name',
    ].filter(Boolean),
    vision: [
      (data.videoOptions || []).length < 2 && !data.requirement?.trim() && 'Requirement',
    ].filter(Boolean),
    pricing: [
      !basePriceOk && (data.partnerProgramme?.enabled ? 'Base price must be £0 or more' : 'Base price must be greater than 0'),
    ].filter(Boolean),
  };
  const totalIssues = Object.values(issues).flat().length;

  const proposalLabel = isDefault
    ? 'Default proposal — the base for every new proposal'
    : isTemplate
    ? 'Template: ' + (data.name || 'Untitled')
    : [data.clientName, data.contactBusinessName].filter(Boolean).join(' · ') || 'New Proposal';

  // Mobile section state + nav. Each Section is keyed and gets a ref so the
  // nav strip can scrollIntoView and force-expand. On desktop this state is
  // ignored (Section receives no controlled `collapsed` prop and behaves as
  // it always has).
  const sectionRefs = useRef({});
  const [collapsedMap, setCollapsedMap] = useState({});
  const sectionMeta = useMemo(() => buildSectionMeta(data, isTemplate, issues, isDefault), [data, isTemplate, issues, isDefault]);
  const setCollapsed = (id, value) => setCollapsedMap(m => ({ ...m, [id]: value }));
  const sectionProps = (id) => isMobile
    ? {
        ref: (el) => { sectionRefs.current[id] = el; },
        collapsible: true,
        collapsed: collapsedMap[id] !== undefined ? collapsedMap[id] : true, // default collapsed on mobile
        onCollapsedChange: (v) => setCollapsed(id, v),
      }
    : {
        ref: (el) => { sectionRefs.current[id] = el; },
      };
  const jumpToSection = (id) => {
    setCollapsed(id, false);
    requestAnimationFrame(() => {
      sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // A signed proposal is a contract — its terms and pricing are frozen. The
  // builder auto-saves every keystroke, so we block it outright rather than
  // disable inputs one by one; this also catches deep links to #/builder/<id>.
  // The server refuses the writes too (PUT /api/proposals/:id).
  if (signature) {
    const signedOn = signature.signedAt
      ? new Date(signature.signedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : null;
    return (
      <div style={{ maxWidth: 620, margin: '0 auto', padding: isMobile ? '32px 12px' : '64px 24px' }}>
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 20 : 32, textAlign: 'center' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ECFDF5', color: '#15803D', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
            <Lock size={20} />
          </div>
          <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700 }}>This proposal is signed</h2>
          <p style={{ margin: '0 0 6px', fontSize: 13.5, color: BRAND.muted, lineHeight: 1.5 }}>
            {[signature.name, signedOn && 'accepted it on ' + signedOn].filter(Boolean).join(' ') || 'It has been accepted'} — so it&rsquo;s locked. Editing it now would change the terms the client agreed to.
          </p>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
            To make changes, remove the signature first (&ldquo;Unmark as accepted&rdquo; on the proposals list), or duplicate it as a new proposal.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={onBack} className="btn-ghost"><ChevronLeft size={14} /> Back</button>
            {onPreview && <button onClick={onPreview} className="btn"><Eye size={14} /> View proposal</button>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '12px 12px 96px' : 24 }}>

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

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: isMobile ? 'flex-start' : 'center',
          gap: 2,
          flex: 1,
          minWidth: 0,
          padding: '0 12px',
          order: isMobile ? 3 : 0,
          width: isMobile ? '100%' : 'auto',
        }}>
          {!isMobile && (
            <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
              {proposalLabel}
            </div>
          )}
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

        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {!isMobile && !isTemplate && (
            <button onClick={() => { setTplName(data.contactBusinessName ? data.contactBusinessName + ' template' : ''); setShowSaveTpl(true); }} className="btn-ghost">
              <Save size={14} /> Save as template
            </button>
          )}
          {!isMobile && !isTemplate && <button onClick={onPreview} className="btn"><Eye size={14} /> Preview</button>}
          {!isMobile && isTemplate && <button onClick={onBack} className="btn"><Check size={14} /> Done</button>}
        </div>
      </div>

      {/* ── Section nav strip (mobile only) ── */}
      {isMobile && (
        <div style={{
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
          padding: '8px 2px 12px',
          marginBottom: 4,
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}>
          {sectionMeta.map(s => (
            <button
              key={s.id}
              onClick={() => jumpToSection(s.id)}
              style={{
                flexShrink: 0,
                background: 'white',
                border: '1px solid ' + (s.hasIssues ? '#FDBA74' : BRAND.border),
                borderRadius: 999,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 600,
                color: BRAND.ink,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: s.hasIssues ? '#F59E0B' : '#22C55E',
                flexShrink: 0,
              }} />
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Proposal type ──
          A Content Credit proposal is a different shape of proposal, not a
          Partner Programme add-on: the deliverable is quoted in minutes and the
          whole credit config lives in Pricing, so the Partner Programme section
          disappears entirely. Stored as partnerProgramme.mode/creditOnly. */}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: BRAND.muted, marginBottom: 10 }}>
          Proposal type
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { key: 'standard', label: 'Standard', hint: 'Quote a project, with the Partner Programme as an optional add-on.' },
            { key: 'credit', label: 'Content Credit', hint: 'Quote an amount of minutes; the client can add more at a discount.' },
          ].map((opt) => {
            const active = (isCreditOnly ? 'credit' : 'standard') === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => update({
                  partnerProgramme: {
                    ...data.partnerProgramme,
                    enabled: opt.key === 'credit' ? true : data.partnerProgramme?.enabled,
                    ...(opt.key === 'credit'
                      ? { mode: 'oneoff', creditOnly: true, quotedMinutes: data.partnerProgramme?.quotedMinutes ?? 1 }
                      : { creditOnly: false }),
                  },
                })}
                style={{
                  flex: isMobile ? '1 1 100%' : '1 1 0', textAlign: 'left', padding: '10px 12px', borderRadius: 8,
                  border: '2px solid ' + (active ? '#b45309' : BRAND.border), background: active ? '#FFFAEB' : 'white', cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: active ? '#92400E' : BRAND.ink }}>{opt.label}</div>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, lineHeight: 1.4 }}>{opt.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Client Details / Template Info / Default proposal ── */}
      <Section
        title={isDefault ? 'Default proposal' : isTemplate ? 'Template Info' : 'Client Details'}
        color="#0369a1"
        icon={Building2}
        badge={isTemplate ? null : <SectionStatus issues={issues.client} />}
        collapsedHint={sectionMeta.find(s => s.id === 'client')?.hint}
        {...sectionProps('client')}
      >
        {isDefault ? (
          <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
            Everything you set here becomes the starting point for every new
            proposal — intro, team, requirement, pricing, inclusions, extras and
            payment options. Client-specific details (name, business, logo) are
            left blank and filled in per proposal.
          </div>
        ) : isTemplate ? (
          <Field label="Template name">
            <input
              className="input"
              value={data.name || ''}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="e.g. NHS / SMB / Standard 60s"
            />
          </Field>
        ) : (
          <>
            <Field label="Client name" error={!data.clientName?.trim()}>
              <input className="input" value={data.clientName} onChange={(e) => update({ clientName: e.target.value })} placeholder="e.g. John Smith" />
            </Field>
            <Field label="Business name" error={!data.contactBusinessName?.trim()}>
              <input className="input" value={data.contactBusinessName} onChange={(e) => update({ contactBusinessName: e.target.value })} placeholder="e.g. Acme Ltd" />
            </Field>
            <ClientLinkPanel
              data={data}
              update={update}
              proposalId={id}
              showMsg={showMsg}
            />
            <Field label="Proposal title (optional)">
              <input className="input" value={data.proposalTitle || ''} onChange={(e) => update({ proposalTitle: e.target.value })} placeholder="Explainer Video Proposal" />
            </Field>
            <Field label="Client logo (optional)">
              <LogoUploader logo={data.clientLogo} onChange={(logo) => update({ clientLogo: logo })} showMsg={showMsg} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: 12 }}>
              <Field label="Date">
                <input className="input" value={data.date} onChange={(e) => update({ date: e.target.value })} />
              </Field>
              <Field label="Expires">
                <input
                  type="date"
                  className="input"
                  value={data.expiryDate || defaultExpiryISO(data.date, data.validityDays)}
                  onChange={(e) => update({ expiryDate: e.target.value })}
                />
              </Field>
              <Field label="Prepared by">
                <input className="input" value={data.preparedBy} onChange={(e) => update({ preparedBy: e.target.value })} />
              </Field>
            </div>
            <Field label="Job title">
              <input className="input" value={data.preparedByTitle || ''} onChange={(e) => update({ preparedByTitle: e.target.value })} placeholder="e.g. Partnership Lead" />
            </Field>

            <div style={{ marginTop: 6, paddingTop: 14, borderTop: '1px solid ' + BRAND.border }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>Introduction</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 12, padding: '8px 10px', background: data.showIntro === false ? '#FFF7ED' : BRAND.paper, border: '1px solid ' + (data.showIntro === false ? '#FED7AA' : BRAND.border), borderRadius: 8 }}>
                <input
                  type="checkbox"
                  checked={data.showIntro !== false}
                  onChange={(e) => update({ showIntro: e.target.checked })}
                />
                <span style={{ fontWeight: 600 }}>Show the introduction on this proposal</span>
                {data.showIntro === false && <span style={{ color: '#9A3412', fontSize: 12 }}>— hidden on proposal &amp; PDF</span>}
              </label>
              {data.showIntro !== false && (
                <>
                  <Field label="Heading (leave blank for the default)">
                    <input
                      className="input"
                      value={data.introHeading || ''}
                      onChange={(e) => update({ introHeading: e.target.value })}
                      placeholder={data.contactBusinessName ? `${data.contactBusinessName}, thank you for considering Squideo as your creative partner` : 'Thank you for considering Squideo as your creative partner'}
                    />
                  </Field>
                  <Field label="Intro text">
                    <textarea
                      className="input"
                      style={{ minHeight: 120 }}
                      value={data.intro || ''}
                      onChange={(e) => update({ intro: e.target.value })}
                      placeholder="Introduce Squideo to the client… (leave a blank line between paragraphs)"
                    />
                  </Field>
                </>
              )}
            </div>
          </>
        )}
      </Section>

      {/* ── Project Vision ── */}
      <Section
        title="Project Vision"
        color="#7c3aed"
        icon={Lightbulb}
        badge={<SectionStatus issues={issues.vision} />}
        collapsedHint={sectionMeta.find(s => s.id === 'vision')?.hint}
        {...sectionProps('vision')}
      >
        <Field label="Your Requirement">
          <textarea
            className="input"
            style={{ minHeight: isMobile ? 80 : 110, resize: 'vertical' }}
            value={data.requirementSummary || ''}
            onChange={(e) => update({ requirementSummary: e.target.value })}
            placeholder="A short summary of what the client needs — shown as 'Your Requirement' above Your Quote on the proposal."
          />
        </Field>
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '4px 0 18px' }}>Free text shown to the client above the quote. Leave blank to hide it{(data.videoOptions || []).length === 0 ? ' (the single requirement below is used as a fallback)' : ''}.</p>
        {(data.videoOptions || []).length > 0 ? (
          <>
            {data.videoOptions.map((opt, i) => (
              <div key={i} style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, marginBottom: 12, background: BRAND.paper }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: BRAND.text }}>Option {i + 1}</div>
                  <button
                    className="btn-ghost"
                    style={{ fontSize: 11, color: BRAND.muted, padding: '2px 6px' }}
                    onClick={() => update({ videoOptions: data.videoOptions.filter((_, idx) => idx !== i) })}
                  >
                    <X size={11} /> Remove
                  </button>
                </div>
                <Field label="Label (shown on radio button)">
                  <input
                    className="input"
                    placeholder="e.g. 1-minute video"
                    value={opt.label}
                    onChange={(e) => {
                      const next = [...data.videoOptions];
                      next[i] = { ...next[i], label: e.target.value };
                      update({ videoOptions: next });
                    }}
                  />
                </Field>
                <Field label="Description (free text shown to client)">
                  <textarea
                    rows={6}
                    className="input"
                    style={{ minHeight: isMobile ? 80 : 120, resize: 'vertical' }}
                    placeholder={"1 x HD Animated explainer video - up to 60 seconds\n1 x Short social cutdown - 15 seconds"}
                    value={opt.description}
                    onChange={(e) => {
                      const next = [...data.videoOptions];
                      next[i] = { ...next[i], description: e.target.value };
                      update({ videoOptions: next });
                    }}
                  />
                </Field>
                {isCreditOnly && (
                  <Field label="Minutes of content credit">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <PriceInput
                        className="input" min="0" step="0.5" style={{ maxWidth: 120 }}
                        value={opt.minutes ?? 1}
                        onChange={(n) => {
                          const next = [...data.videoOptions];
                          next[i] = { ...next[i], minutes: n, price: minutesToPrice(n) };
                          update({ videoOptions: next });
                        }}
                      />
                      <span style={{ fontSize: 13, color: BRAND.muted }}>
                        × {formatGBP(creditRatePerMin)}/min = <strong style={{ color: BRAND.ink }}>{formatGBP(minutesToPrice(opt.minutes ?? 1))}</strong>
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
                      Sets the price below. Edit the price to override with a negotiated total.
                    </div>
                  </Field>
                )}
                <Field label={isCreditOnly ? 'Price (ex VAT) — override' : 'Price (ex VAT)'}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, color: BRAND.muted }}>£</span>
                    <PriceInput
                      className="input"
                      placeholder="0"
                      value={opt.price}
                      onChange={(n) => {
                        const next = [...data.videoOptions];
                        next[i] = { ...next[i], price: n };
                        update({ videoOptions: next });
                      }}
                    />
                  </div>
                </Field>
              </div>
            ))}
            <button
              className="btn-ghost"
              style={{ fontSize: 12, marginTop: 4 }}
              onClick={() => update({
                videoOptions: [
                  ...data.videoOptions,
                  { label: `Option ${data.videoOptions.length + 1}`, description: '', price: data.basePrice || 0 },
                ],
              })}
            >
              <Plus size={13} /> Add option
            </button>
            <button
              className="btn-ghost"
              style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}
              onClick={() => {
                update({
                  requirement: data.videoOptions[0]?.description || '',
                  videoOptions: [],
                });
              }}
            >
              <X size={13} /> Switch back to single requirement
            </button>
          </>
        ) : (
          <>
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
            <button
              className="btn-ghost"
              style={{ fontSize: 12, marginTop: 4 }}
              onClick={() => update({
                videoOptions: [
                  { label: 'Option 1', description: data.requirement || '', price: data.basePrice || 0 },
                  { label: 'Option 2', description: '', price: data.basePrice || 0 },
                ],
              })}
            >
              <Plus size={13} /> Activate Option Mode
            </button>
          </>
        )}
        <Field label="Vision (problem and solution)">
          <textarea className="input" style={{ minHeight: 100 }} value={data.projectVision} onChange={(e) => update({ projectVision: e.target.value })} placeholder="Describe the problem and how the videos will solve it…" />
        </Field>
      </Section>

      {/* ── Delivery Team ── */}
      <Section
        title="Delivery Team"
        color="#0f766e"
        icon={Users}
        collapsible
        defaultCollapsed
        collapsedHint={isMobile ? sectionMeta.find(s => s.id === 'team')?.hint : 'Click to expand and edit team members'}
        {...sectionProps('team')}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={data.showDeliveryTeam !== false}
            onChange={(e) => update({ showDeliveryTeam: e.target.checked })}
          />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Show delivery team on this proposal</span>
        </label>
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '0 0 16px' }}>Photos appear on the client proposal. Untick to hide the whole Delivery Team section from this proposal.</p>
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
      <Section
        title="Production Process"
        color="#c2410c"
        icon={Video}
        collapsible
        defaultCollapsed
        collapsedHint={isMobile ? sectionMeta.find(s => s.id === 'process')?.hint : 'Click to expand and edit the production-process video'}
        {...sectionProps('process')}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={data.showProcessVideo !== false}
            onChange={(e) => update({ showProcessVideo: e.target.checked })}
          />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Show production-process video on this proposal</span>
        </label>
        <Field label="Video URL">
          <input
            className="input"
            value={data.processVideoUrl || ''}
            onChange={(e) => update({ processVideoUrl: e.target.value })}
            placeholder="YouTube or Vimeo URL — leave blank to hide this section"
          />
        </Field>
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '4px 0 0' }}>Paste a YouTube or Vimeo link. The section appears on the proposal only when this is set <em>and</em> the checkbox above is ticked.</p>
      </Section>

      {/* ── Notable Examples ── */}
      <Section
        title="Notable Examples"
        color="#7c3aed"
        icon={Star}
        collapsible
        defaultCollapsed
        collapsedHint={isMobile ? sectionMeta.find(s => s.id === 'examples')?.hint : 'Click to expand and add up to 3 example videos'}
        {...sectionProps('examples')}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!data.showNotableExamples}
            onChange={(e) => update({ showNotableExamples: e.target.checked })}
          />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Show notable examples on this proposal</span>
        </label>
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '0 0 16px' }}>Paste up to 3 Vimeo links. The title is pulled from Vimeo automatically — tweak it if you like.</p>
        {(data.notableExamples || []).map((ex, i) => (
          <div key={ex.id || i} style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>Example {i + 1}</span>
              <button
                onClick={() => update({ notableExamples: (data.notableExamples || []).filter((_, idx) => idx !== i) })}
                className="btn-ghost"
                style={{ padding: '4px 8px' }}
              >
                <X size={14} /> Remove
              </button>
            </div>
            <Field label="Vimeo URL">
              <input
                className="input"
                value={ex.url || ''}
                onChange={(e) => updateExample(i, { url: e.target.value })}
                onBlur={(e) => autofillExampleMeta(i, e.target.value)}
                placeholder="https://vimeo.com/123456789"
              />
            </Field>
            <Field label="Title (shown on the proposal)">
              <input
                className="input"
                value={ex.title || ''}
                onChange={(e) => updateExample(i, { title: e.target.value })}
                placeholder="Auto-filled from Vimeo — edit as needed"
              />
            </Field>
          </div>
        ))}
        {(data.notableExamples || []).length < 3 && (
          <button
            onClick={() => update({ notableExamples: [...(data.notableExamples || []), { id: 'ex_' + Date.now(), url: '', title: '' }] })}
            className="btn-ghost"
          >
            <Plus size={14} /> Add example
          </button>
        )}
      </Section>

      {/* ── Pricing ── */}
      <Section
        title="Pricing"
        color="#15803d"
        icon={PoundSterling}
        badge={<SectionStatus issues={issues.pricing} />}
        collapsedHint={sectionMeta.find(s => s.id === 'pricing')?.hint}
        {...sectionProps('pricing')}
      >
        {isCreditOnly && (data.videoOptions || []).length === 0 && (
          <Field label="Minutes of content credit quoted">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <PriceInput
                className="input" min="0" step="0.5" style={{ maxWidth: 120 }}
                value={data.partnerProgramme?.quotedMinutes ?? 1}
                onChange={(n) => update({
                  partnerProgramme: { ...data.partnerProgramme, quotedMinutes: n },
                  basePrice: minutesToPrice(n),
                })}
              />
              <span style={{ fontSize: 13, color: BRAND.muted }}>
                × {formatGBP(creditRatePerMin)}/min = <strong style={{ color: BRAND.ink }}>{formatGBP(minutesToPrice(data.partnerProgramme?.quotedMinutes ?? 1))}</strong>
              </span>
            </div>
            <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
              Sets the base price below. Edit the base price to override with a negotiated total.
            </div>
          </Field>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <Field label={isCreditOnly ? 'Project base price (ex VAT) — override' : 'Project base price (ex VAT)'} error={!basePriceOk}>
            <PriceInput className="input" value={data.basePrice} onChange={(n) => update({ basePrice: n })} />
            {data.partnerProgramme?.enabled && Number(data.basePrice) === 0 && (
              <div style={{ fontSize: 12, color: '#15803d', marginTop: 4, fontWeight: 600 }}>
                First video free with the Partner Programme retainer.
              </div>
            )}
          </Field>
          <Field label="VAT rate (%)">
            <PriceInput step="1" className="input" value={Math.round(data.vatRate * 100)} onChange={(n) => update({ vatRate: n / 100 })} />
          </Field>
        </div>

        {/* Simple manual discount on the base price (standard flow only). */}
        <DiscountEditor
          basePrice={data.basePrice}
          discount={data.discount}
          onChange={(discount) => update({ discount })}
          isMobile={isMobile}
        />
        <Field label="Standard rate per minute (£/min)">
          <PriceInput
            min="0" step="1"
            className="input"
            value={data.partnerProgramme?.standardRatePerMin ?? data.basePrice ?? 0}
            onChange={(n) => update({
              partnerProgramme: {
                ...data.partnerProgramme,
                standardRatePerMin: n,
              },
            })}
          />
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
            {isCreditOnly
              ? 'The standard per-minute rate. Quoted minutes are priced at this rate; added credit is discounted from it.'
              : 'The headline per-minute rate used in the Partner Programme — independent of the project base price above.'}
          </div>
        </Field>

        {/* Content Credit proposals own their credit config here — there is no
            Partner Programme section on this proposal type. */}
        {isCreditOnly && (
          <div style={{ border: '1px solid #FDE68A', background: '#FFFBEB', borderRadius: 10, padding: 14, marginTop: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#92400E', marginBottom: 4 }}>
              Added content credit
            </div>
            <p style={{ fontSize: 12, color: '#78350F', margin: '0 0 12px', lineHeight: 1.5 }}>
              What the client sees if they add more minutes on top of the quote. The quoted minutes above are never
              discounted — only the extra minutes added here.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
              <Field label="Added-credit rate (auto-derived)">
                <CreditRatePreview
                  pp={data.partnerProgramme}
                  basePrice={data.basePrice}
                  note="Price per added minute — the standard rate × discount tier; tweak the tier on the right."
                />
              </Field>
              <Field label="Added-credit discount tiers">
                <CreditTierFields
                  pp={data.partnerProgramme}
                  onChange={(partnerProgramme) => update({ partnerProgramme })}
                />
              </Field>
            </div>
            <Field label="Description">
              <textarea
                className="input"
                style={{ minHeight: 60 }}
                value={data.partnerProgramme.description}
                onChange={(e) => update({ partnerProgramme: { ...data.partnerProgramme, description: e.target.value } })}
              />
            </Field>
          </div>
        )}

        {data.basePrice > 0 && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#15803d', fontWeight: 600 }}>
            Total inc. VAT: £{(data.basePrice * (1 + data.vatRate)).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        )}

        {(data.videoOptions || []).length > 0 && (
          <div style={{ background: '#f0f4ff', border: '1px solid #c7d2fe', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#3730a3', marginTop: 8 }}>
            Option mode active — prices are set per option in the Project Vision section above.
          </div>
        )}
      </Section>

      {/* ── Payment Options ── */}
      <Section
        title="Payment Options"
        color="#1d4ed8"
        icon={CreditCard}
        collapsedHint={sectionMeta.find(s => s.id === 'payment')?.hint}
        {...sectionProps('payment')}
      >
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
                {key === 'full' && enabled && (() => {
                  // Whether to dangle an incentive (free subtitled version) for
                  // paying in full. Defaults ON; absent flag = included.
                  const incentiveOn = data.payInFullIncentive !== false;
                  return (
                    <div style={{ paddingLeft: 26, paddingBottom: 10 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: incentiveOn ? 10 : 0 }}>
                        <input
                          type="checkbox"
                          checked={incentiveOn}
                          onChange={(e) => update({ payInFullIncentive: e.target.checked })}
                        />
                        <span>Include a pay-in-full incentive shown to the client</span>
                      </label>
                      {incentiveOn && (
                        <>
                          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 4 }}>Custom incentive text (optional)</div>
                          <input
                            className="input"
                            style={{ fontSize: 13 }}
                            value={data.paymentOptionDescs?.full || ''}
                            placeholder={`get a free subtitled version (worth £${subtitlesPrice})`}
                            onChange={(e) => update({ paymentOptionDescs: { ...data.paymentOptionDescs, full: e.target.value } })}
                          />
                          <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>Leave blank to use the auto-generated text. Replaces the incentive shown to the client.</div>
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          });
        })()}
      </Section>

      {/* ── What's Included ── */}
      <Section
        title="What's Included"
        color="#0e7490"
        icon={List}
        collapsedHint={sectionMeta.find(s => s.id === 'inclusions')?.hint}
        {...sectionProps('inclusions')}
      >
        {data.baseInclusions.map((inc, i) => (
          <div
            key={i}
            onDragOver={(e) => {
              if (inclusionsReorder.draggingIdx === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (inclusionsReorder.overIdx !== i) inclusionsReorder.over(i);
            }}
            onDrop={(e) => {
              const from = inclusionsReorder.draggingIdx;
              if (from === null) return;
              e.preventDefault();
              if (from !== i) update({ baseInclusions: reorderArray(data.baseInclusions, from, i) });
              inclusionsReorder.reset();
            }}
            style={{
              border: '1px solid ' + (inclusionsReorder.overIdx === i && inclusionsReorder.draggingIdx !== null && inclusionsReorder.draggingIdx !== i ? BRAND.blue : BRAND.border),
              borderRadius: 10,
              padding: 12,
              marginBottom: 10,
              opacity: inclusionsReorder.draggingIdx === i ? 0.4 : 1,
              transition: 'border-color 120ms, opacity 120ms',
            }}
          >
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <DragHandle
                onDragStart={(e) => {
                  inclusionsReorder.start(i);
                  e.dataTransfer.effectAllowed = 'move';
                  try { e.dataTransfer.setData('text/plain', String(i)); } catch {}
                }}
                onDragEnd={inclusionsReorder.reset}
              />
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

      {/* ── Partner Programme ──
          Absent on Content Credit proposals: there the credit config lives in
          Pricing and the proposal isn't a project + partner add-on at all. */}
      {!isCreditOnly && (
      <Section
        title="Partner Programme"
        color="#b45309"
        icon={Star}
        collapsedHint={sectionMeta.find(s => s.id === 'partner')?.hint}
        {...sectionProps('partner')}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, cursor: 'pointer' }}>
          <input type="checkbox" checked={data.partnerProgramme.enabled} onChange={(e) => update({ partnerProgramme: { ...data.partnerProgramme, enabled: e.target.checked } })} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Show Partner Programme on this proposal</span>
        </label>
        {data.partnerProgramme.enabled && (
          <>
            <Field label="Programme type">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  { key: 'subscription', label: 'Monthly subscription', hint: 'Recurring content credit, charged monthly — cancel any time.' },
                  { key: 'oneoff', label: 'One-off content credit', hint: 'A single upfront purchase of content credit for future use.' },
                ].map((opt) => {
                  const active = (data.partnerProgramme.mode || 'subscription') === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => update({ partnerProgramme: { ...data.partnerProgramme, mode: opt.key } })}
                      style={{
                        flex: isMobile ? '1 1 100%' : '1 1 0', textAlign: 'left', padding: '10px 12px', borderRadius: 8,
                        border: '2px solid ' + (active ? '#b45309' : BRAND.border), background: active ? '#FFFAEB' : 'white', cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 700, color: active ? '#92400E' : BRAND.ink }}>{opt.label}</div>
                      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, lineHeight: 1.4 }}>{opt.hint}</div>
                    </button>
                  );
                })}
              </div>
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
              <Field label={(data.partnerProgramme.mode === 'oneoff' ? 'Content credit rate' : 'Monthly subscription rate') + ' (auto-derived)'}>
                <CreditRatePreview
                  pp={data.partnerProgramme}
                  basePrice={data.basePrice}
                  suffix={data.partnerProgramme.mode === 'oneoff' ? '' : '/mo'}
                  note={data.partnerProgramme.mode === 'oneoff'
                    ? 'One-off price per minute of credit — the standard rate × discount tier; tweak the tier on the right.'
                    : 'Per-minute rate is the standard rate × discount tier; tweak the tier on the right to change it.'}
                />
              </Field>
              <Field label="Project discount tiers">
                <CreditTierFields
                  pp={data.partnerProgramme}
                  onChange={(partnerProgramme) => update({ partnerProgramme })}
                />
              </Field>
            </div>
            <Field label="Description">
              <textarea className="input" style={{ minHeight: 60 }} value={data.partnerProgramme.description} onChange={(e) => update({ partnerProgramme: { ...data.partnerProgramme, description: e.target.value } })} />
            </Field>
          </>
        )}
      </Section>
      )}

      {/* ── Optional Extras ── */}
      <Section
        title="Optional Extras"
        color="#be185d"
        icon={Package}
        collapsedHint={sectionMeta.find(s => s.id === 'extras')?.hint}
        {...sectionProps('extras')}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 12, padding: '8px 10px', background: data.hideOptionalExtras ? '#FFF7ED' : BRAND.paper, border: '1px solid ' + (data.hideOptionalExtras ? '#FED7AA' : BRAND.border), borderRadius: 8 }}>
          <input
            type="checkbox"
            checked={!!data.hideOptionalExtras}
            onChange={(e) => update({ hideOptionalExtras: e.target.checked })}
          />
          <span style={{ fontWeight: 600 }}>Hide the Optional Extras section from the client</span>
          {data.hideOptionalExtras && <span style={{ color: '#9A3412', fontSize: 12 }}>— hidden on the proposal &amp; PDF</span>}
        </label>
        {data.hideOptionalExtras && (
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 12 }}>
            Your extras below are kept but won&apos;t be shown to the client. Untick to show the section again.
          </div>
        )}
        {data.optionalExtras.map((extra, i) => (
          <div
            key={extra.id}
            onDragOver={(e) => {
              if (extrasReorder.draggingIdx === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (extrasReorder.overIdx !== i) extrasReorder.over(i);
            }}
            onDrop={(e) => {
              const from = extrasReorder.draggingIdx;
              if (from === null) return;
              e.preventDefault();
              if (from !== i) update({ optionalExtras: reorderArray(data.optionalExtras, from, i) });
              extrasReorder.reset();
            }}
            style={{
              border: '1px solid ' + (extrasReorder.overIdx === i && extrasReorder.draggingIdx !== null && extrasReorder.draggingIdx !== i ? BRAND.blue : BRAND.border),
              borderRadius: 10,
              padding: 12,
              marginBottom: 10,
              opacity: extrasReorder.draggingIdx === i ? 0.4 : 1,
              transition: 'border-color 120ms, opacity 120ms',
            }}
          >
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <DragHandle
                onDragStart={(e) => {
                  extrasReorder.start(i);
                  e.dataTransfer.effectAllowed = 'move';
                  try { e.dataTransfer.setData('text/plain', String(i)); } catch {}
                }}
                onDragEnd={extrasReorder.reset}
              />
              <input className="input" style={{ flex: 1 }} value={extra.label} onChange={(e) => updateExtra(i, { label: e.target.value })} />
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: BRAND.muted, pointerEvents: 'none' }}>£</span>
                <PriceInput className="input" style={{ width: 90, paddingLeft: 22 }} value={extra.price} onChange={(n) => updateExtra(i, { price: n })} />
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
            {VARIANT_ELIGIBLE_IDS.has(extra.id) && (() => {
              const variantsOn = extraHasVariants(extra);
              return (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: BRAND.muted, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={variantsOn}
                    onChange={(e) => updateExtra(i, { variantsEnabled: e.target.checked })}
                  />
                  Per-language pricing {variantsOn && <span style={{ color: BRAND.muted }}>— price above is charged per language</span>}
                </label>
              );
            })()}
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

      {/* Mobile: sticky bottom action bar */}
      {isMobile && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'white',
          borderTop: '1px solid ' + BRAND.border,
          padding: '10px 14px',
          display: 'flex',
          gap: 8,
          zIndex: 20,
          boxShadow: '0 -2px 8px rgba(0,0,0,0.05)',
        }}>
          {!isTemplate && (
            <button
              onClick={() => { setTplName(data.contactBusinessName ? data.contactBusinessName + ' template' : ''); setShowSaveTpl(true); }}
              className="btn-ghost"
              style={{ flex: 1, justifyContent: 'center' }}
            >
              <Save size={14} /> Template
            </button>
          )}
          {!isTemplate && (
            <button onClick={onPreview} className="btn" style={{ flex: 1, justifyContent: 'center' }}>
              <Eye size={14} /> Preview
            </button>
          )}
          {isTemplate && (
            <button onClick={onBack} className="btn" style={{ flex: 1, justifyContent: 'center' }}>
              <Check size={14} /> Done
            </button>
          )}
        </div>
      )}
    </div>
  );
}
