import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, Mail, MoreVertical, Phone, Video, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { SQUIDEO_LOGO } from '../defaults.js';
import { formatGBP, useIsMobile } from '../utils.js';

export function Logo({ size, dark }) {
  const height = size || 36;
  return (
    <img
      src={SQUIDEO_LOGO}
      alt="Squideo"
      style={{
        height,
        width: 'auto',
        display: 'block',
        ...(dark ? {} : { background: BRAND.ink, padding: '4px 10px', borderRadius: 8 })
      }}
    />
  );
}

export const Section = React.forwardRef(function Section(
  { title, children, color, icon: Icon, badge, collapsible = false, defaultCollapsed = false, collapsedHint, collapsed: controlledCollapsed, onCollapsedChange },
  ref
) {
  const isMobile = useIsMobile();
  const accent = color || BRAND.blue;
  const [internalCollapsed, setInternalCollapsed] = useState(collapsible ? defaultCollapsed : false);
  const isControlled = controlledCollapsed !== undefined;
  const collapsed = isControlled ? controlledCollapsed : internalCollapsed;
  const setCollapsed = (next) => {
    const value = typeof next === 'function' ? next(collapsed) : next;
    if (onCollapsedChange) onCollapsedChange(value);
    if (!isControlled) setInternalCollapsed(value);
  };
  const toggle = collapsible ? () => setCollapsed(c => !c) : undefined;

  return (
    <div ref={ref} style={{
      background: 'white',
      borderTop: '1px solid ' + BRAND.border,
      borderRight: '1px solid ' + BRAND.border,
      borderBottom: '1px solid ' + BRAND.border,
      borderLeft: '4px solid ' + accent,
      borderRadius: 12,
      marginBottom: 20,
      overflow: 'hidden',
      boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
      scrollMarginTop: 84,
    }}>
      <div
        onClick={toggle}
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        onKeyDown={collapsible ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } : undefined}
        aria-expanded={collapsible ? !collapsed : undefined}
        style={{
          padding: isMobile ? '11px 14px' : '12px 20px',
          background: accent + '12',
          borderBottom: collapsed ? 'none' : '1px solid ' + BRAND.border,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          cursor: collapsible ? 'pointer' : 'default',
          userSelect: collapsible ? 'none' : 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {Icon && <Icon size={14} color={accent} strokeWidth={2.5} />}
          <h2 className="section-label" style={{ margin: 0, fontSize: 11, fontWeight: 700, color: accent, letterSpacing: 0.7, textTransform: 'uppercase' }}>{title}</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {badge}
          {collapsible && (
            <ChevronDown
              size={16}
              color={accent}
              style={{ transition: 'transform 150ms ease', transform: collapsed ? 'rotate(-90deg)' : 'none' }}
            />
          )}
        </div>
      </div>
      {!collapsed && (
        <div style={{ padding: isMobile ? 14 : 20 }}>
          {children}
        </div>
      )}
      {collapsed && collapsedHint && (
        <div
          onClick={toggle}
          style={{ padding: '10px 20px', fontSize: 12, color: BRAND.muted, fontStyle: 'italic', cursor: 'pointer', background: 'white' }}
        >
          {collapsedHint}
        </div>
      )}
    </div>
  );
});

export function Field({ label, children, htmlFor, error }) {
  const fallbackId = useId();
  const targetId = htmlFor || fallbackId;
  const child = React.isValidElement(children) && !children.props.id
    ? React.cloneElement(children, { id: targetId })
    : children;
  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={targetId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
        <span>{label}</span>
        {error && <span style={{ fontSize: 11, color: '#92400E', fontWeight: 700, background: '#FEF3C7', padding: '1px 7px', borderRadius: 10 }}>Required</span>}
      </label>
      {child}
    </div>
  );
}

export function PageTitle({ children }) {
  const isMobile = useIsMobile();
  return (
    <h2 style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, margin: isMobile ? '24px 0 10px' : '32px 0 12px', paddingBottom: 8, borderBottom: '2px solid ' + BRAND.blue }}>
      {children}
    </h2>
  );
}

export function PriceRow({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: bold ? 'none' : '1px solid ' + BRAND.border, fontWeight: bold ? 700 : 400, fontSize: bold ? 16 : 14 }}>
      <span>{label}</span>
      <span>{formatGBP(value)}</span>
    </div>
  );
}

export function PaymentOption({ selected, onSelect, title, desc, disabled, disabledReason, recommended }) {
  const handleClick = () => { if (!disabled && onSelect) onSelect(); };
  return (
    <label
      onClick={handleClick}
      title={disabled && disabledReason ? disabledReason : undefined}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: 16,
        border: '2px solid ' + (selected ? BRAND.blue : BRAND.border),
        borderRadius: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: disabled ? '#F4F6F8' : (selected ? '#F0F9FF' : 'white'),
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid ' + (selected ? BRAND.blue : BRAND.muted), flexShrink: 0, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {selected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: BRAND.blue }} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          {recommended && <Badge color="gold">Recommended</Badge>}
        </div>
        <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>{desc}</div>
        {disabled && disabledReason && (
          <div style={{ fontSize: 12, color: '#92400E', marginTop: 6, fontStyle: 'italic' }}>{disabledReason}</div>
        )}
      </div>
    </label>
  );
}

export function Badge({ color, children }) {
  const colors = {
    green:  { bg: '#E8F5E9', fg: '#2E7D32' },
    yellow: { bg: '#FFF8E1', fg: '#B26A00' },
    blue:   { bg: '#E3F2FD', fg: '#0D47A1' },
    orange: { bg: '#FFF3E0', fg: '#E65100' },
    grey:   { bg: '#ECEFF1', fg: '#455A64' },
    gold:   { bg: '#FEF3C7', fg: '#92400E' },
    purple: { bg: '#F3E8FF', fg: '#6D28D9' }
  };
  const c = colors[color] || colors.green;
  return (
    <span style={{ background: c.bg, color: c.fg, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12 }}>
      {children}
    </span>
  );
}

// A deal or video reference number (2607-014 / 2607-014-01), rendered as a
// monospace pill so it reads as an identifier you can quote back rather than as
// prose. Click to copy — these get pasted into POs, invoices and emails.
// Renders nothing when there's no reference, so callers needn't guard.
export function RefBadge({ reference, size = 11, title }) {
  const [copied, setCopied] = useState(false);
  if (!reference) return null;
  const copy = (e) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard?.writeText(reference).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <button
      onClick={copy}
      title={title || (copied ? 'Copied' : 'Copy reference ' + reference)}
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: size, fontWeight: 600, letterSpacing: 0.3,
        color: copied ? '#2E7D32' : '#475569',
        background: copied ? '#E8F5E9' : '#F1F5F9',
        border: '1px solid ' + (copied ? '#A5D6A7' : 'transparent'),
        borderRadius: 6, padding: '2px 7px', cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >{copied ? 'Copied' : reference}</button>
  );
}

// `dismissible` (default true) controls the easy-close affordances: clicking the
// backdrop and pressing Escape. Set it false for forms where an accidental close
// would lose typed input — pair with `showClose` so there's still an explicit X
// (top-right) to dismiss with.
export function Modal({ children, onClose, maxWidth = 440, overflow = 'auto', dismissible = true, showClose = true, closeOnBackdrop = false, fullScreenOnMobile = true }) {
  const isMobile = useIsMobile();
  // On phones every dialog fills the viewport by default instead of floating in
  // a cramped card behind the keyboard — pass fullScreenOnMobile={false} for the
  // rare small popover that should stay a centred box. This changes geometry
  // only — dismissal still requires the X / Escape / an explicit button
  // (closeOnBackdrop stays off by default), so a half-filled form can't be lost
  // to a stray tap.
  const fullScreen = fullScreenOnMobile && isMobile;
  useEffect(() => {
    if (!dismissible) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, dismissible]);
  // A backdrop click no longer dismisses the modal by default — you close it
  // deliberately via the X, an explicit Cancel/Close button, or Escape — so a
  // stray click (or releasing a text-selection drag) just outside a half-filled
  // form can't discard it. Opt back in with closeOnBackdrop where a quick
  // click-away dismiss is genuinely wanted. The `e.target === e.currentTarget`
  // guard means only a press that both starts and lands on the dim backdrop
  // counts, never one bubbling up from the dialog's contents.
  const onBackdrop = (closeOnBackdrop && dismissible)
    ? (e) => { if (e.target === e.currentTarget) onClose && onClose(); }
    : undefined;
  return (
    <div onMouseDown={onBackdrop} style={{ position: 'fixed', inset: 0, background: 'rgba(15, 42, 61, 0.5)', display: 'flex', alignItems: fullScreen ? 'stretch' : 'center', justifyContent: 'center', zIndex: 2000, padding: fullScreen ? 0 : 20 }}>
      <div role="dialog" aria-modal="true" style={{
        position: 'relative', background: 'white',
        borderRadius: fullScreen ? 0 : 12,
        padding: fullScreen ? '20px 16px calc(20px + env(safe-area-inset-bottom))' : 24,
        paddingTop: fullScreen ? 'calc(20px + env(safe-area-inset-top))' : 24,
        width: '100%', maxWidth: fullScreen ? 'none' : maxWidth,
        boxShadow: fullScreen ? 'none' : '0 20px 60px rgba(0,0,0,0.3)',
        maxHeight: fullScreen ? '100vh' : '90vh', height: fullScreen ? '100vh' : undefined,
        overflowY: overflow,
      }}>
        {showClose && onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute', top: 12, right: 12, zIndex: 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, borderRadius: 8, border: '1px solid ' + BRAND.border,
              background: 'white', color: BRAND.muted, cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

// Renders tabular data as a real <table> on tablet/desktop and as a stack of
// label:value cards on phones, so wide tables don't force horizontal scrolling
// on small screens. `columns` is [{ key, label, render?(row), align?, hideOnMobile? }];
// `render` falls back to row[key]. `onRowClick` makes rows tappable in both modes.
export function ResponsiveTable({ columns, rows, keyField = 'id', onRowClick, empty = 'Nothing to show.' }) {
  const isMobile = useIsMobile();
  const cell = (col, row) => (col.render ? col.render(row) : row[col.key]);

  if (!rows || rows.length === 0) {
    return <div style={{ padding: '24px 16px', textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>{empty}</div>;
  }

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((row, i) => (
          <div
            key={row[keyField] ?? i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            style={{
              border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 14,
              background: 'white', cursor: onRowClick ? 'pointer' : 'default',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}
          >
            {columns.filter(c => !c.hideOnMobile).map((col) => (
              <div key={col.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <span style={{ fontSize: 12, color: BRAND.muted, fontWeight: 600, flexShrink: 0 }}>{col.label}</span>
                <span style={{ fontSize: 14, color: BRAND.ink, textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>{cell(col, row)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} style={{ textAlign: col.align || 'left', padding: '10px 12px', borderBottom: '1px solid ' + BRAND.border, color: BRAND.muted, fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr
            key={row[keyField] ?? i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            style={{ cursor: onRowClick ? 'pointer' : 'default' }}
          >
            {columns.map((col) => (
              <td key={col.key} style={{ textAlign: col.align || 'left', padding: '10px 12px', borderBottom: '1px solid ' + BRAND.paper, color: BRAND.ink }}>
                {cell(col, row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StickyCTA({ totalExVat, partnerMonthlyExVat, partnerOneoff, partnerSelected, phone, email, emailName, onSign, showVat = true }) {
  const isMobile = useIsMobile();
  const telHref = phone ? 'tel:' + String(phone).replace(/[^+\d]/g, '') : null;
  return (
    <div
      className="sticky-cta"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        background: 'white',
        borderTop: '1px solid ' + BRAND.border,
        boxShadow: '0 -4px 16px rgba(15, 42, 61, 0.08)',
        zIndex: 90,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div
        style={{
          maxWidth: 800,
          margin: '0 auto',
          padding: isMobile ? '10px 14px' : '12px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: isMobile ? 10 : 16,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Total</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: isMobile ? 16 : 18, fontWeight: 700, color: BRAND.ink }}>
              {formatGBP(totalExVat)}{showVat && <span style={{ fontSize: 12, color: BRAND.muted, fontWeight: 500 }}> + VAT</span>}
            </span>
            {partnerSelected && partnerMonthlyExVat > 0 && (
              <span style={{ fontSize: 11, color: '#92400E', background: '#FFFAEB', border: '1px solid #FDE68A', padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>
                + {formatGBP(partnerMonthlyExVat)}{showVat && ' + VAT'}{partnerOneoff ? ' credit' : '/mo'}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: isMobile ? 6 : 10, flexShrink: 0 }}>
          {telHref && (
            <a
              href={telHref}
              className="btn-ghost"
              style={{ textDecoration: 'none', whiteSpace: 'nowrap', fontWeight: 600 }}
              aria-label="Call us"
            >
              <Phone size={14} />{!isMobile && <span>Call us</span>}
            </a>
          )}
          {email && (
            <a
              href={'mailto:' + email}
              className="btn-ghost"
              style={{ textDecoration: 'none', whiteSpace: 'nowrap', fontWeight: 600 }}
              aria-label={emailName ? 'Email ' + emailName : 'Email us'}
            >
              <Mail size={14} />{!isMobile && <span>{emailName ? 'Email ' + emailName : 'Email'}</span>}
            </a>
          )}
          <button
            onClick={onSign}
            className="btn"
            style={{ background: '#16A34A', whiteSpace: 'nowrap', fontWeight: 700 }}
          >
            <Check size={16} />
            {isMobile ? 'Sign' : 'Accept & Sign'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: BRAND.ink, color: 'white', padding: '12px 20px', borderRadius: 8, fontSize: 14, fontWeight: 500, zIndex: 3000, maxWidth: '90vw', textAlign: 'center' }}>
      {msg}
    </div>
  );
}

// Shared "⋮" overflow (burger) menu — one compact trigger that pops a list of
// row actions, so each row stays tight instead of carrying a strip of icon
// buttons. `items` is [{ label, icon, onClick, danger, disabled, badge }]; falsy
// items are skipped so callers can inline conditionals. `align` picks which edge
// the panel lines up with. `trigger` swaps the ⋮ glyph; `triggerProps` merges
// styles/aria onto the button.
//
// The panel is portalled to <body> and fixed-positioned from the trigger's rect,
// so it's never clipped by an `overflow: hidden` ancestor (email/task lists,
// card bodies) and never fights their z-index. It flips above the trigger when
// there isn't room below, and closes on scroll/resize/outside-tap/Escape.
export function ActionMenu({ items, align = 'right', trigger, triggerTitle = 'More actions', triggerProps = {}, triggerClassName = 'btn-icon', menuMinWidth = 190 }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const list = (items || []).filter(Boolean);

  const place = () => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const gap = 6;
    const spaceBelow = window.innerHeight - r.bottom;
    const flipUp = spaceBelow < 240 && r.top > spaceBelow;
    setPos({
      top: flipUp ? undefined : r.bottom + gap,
      bottom: flipUp ? window.innerHeight - r.top + gap : undefined,
      left: align === 'left' ? r.left : undefined,
      right: align === 'right' ? window.innerWidth - r.right : undefined,
    });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    const reposition = () => setOpen(false); // simplest: close if the page moves under it
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  if (!list.length) return null;
  const { style: trigStyle, ...trigRest } = triggerProps;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={triggerClassName}
        title={triggerTitle}
        aria-label={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ flexShrink: 0, ...trigStyle }}
        {...trigRest}
      >
        {trigger || <MoreVertical size={16} />}
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right,
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15, 42, 61, 0.16)',
            minWidth: menuMinWidth, maxHeight: '60vh', overflowY: 'auto', padding: 4, zIndex: 4000,
          }}
        >
          {list.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={(e) => { e.stopPropagation(); setOpen(false); item.onClick?.(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '10px 10px', background: 'transparent', border: 'none', borderRadius: 6,
                cursor: item.disabled ? 'default' : 'pointer', fontSize: 13.5, fontWeight: 500,
                color: item.disabled ? BRAND.muted : item.danger ? '#D32F2F' : BRAND.ink,
                opacity: item.disabled ? 0.6 : 1, textAlign: 'left', fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.background = item.danger ? '#FFEBEE' : '#F1F5F9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {item.icon && <item.icon size={15} />}
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge > 0 && (
                <span style={{ background: '#FB923C', color: 'white', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999 }}>
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// Turn a stored phone string into a clean dialable number. The key case: UK
// numbers written "+44 (0)7926 838203" — the "(0)" is the national trunk prefix
// and must be dropped for international dialling, else "+4407926838203" won't
// connect. Also drops a plain trunk 0 sitting right after a "+CC " country code
// (e.g. "+44 07926…"). Anything else just loses its spaces/punctuation.
export function normalizeDialNumber(raw) {
  let s = String(raw || '');
  s = s.replace(/\(\s*0\s*\)/g, ''); // "+44 (0)7926" → "+44 7926"
  // "+44 0 7926" / "+44 07926" → drop the trunk 0 after the country code.
  s = s.replace(/^(\+\d{1,3})[\s-]*0(\d)/, '$1$2');
  return s.replace(/[^+\d]/g, '');
}

// A phone number that, instead of dialling straight from the SIM, opens a small
// menu so you can pick which app places the call — the native Phone app, Webex
// (linked to a work line), or just copy the number. iOS/Android give no OS-level
// "choose calling app" prompt for tel: links, so the app offers it here.
// `display` is the human string shown; the schemes use the cleaned +digits.
export function CallLink({ phone, style, title }) {
  const display = phone == null ? '' : String(phone);
  const clean = normalizeDialNumber(display);
  if (!clean) return display ? <span style={style}>{display}</span> : null;
  const items = [
    { label: 'Call (Phone app)', icon: Phone, onClick: () => { window.location.href = 'tel:' + clean; } },
    { label: 'Call with Webex', icon: Video, onClick: () => { window.location.href = 'webextel://login?telephone=' + encodeURIComponent(clean); } },
    { label: 'Copy number', icon: Copy, onClick: () => { try { navigator.clipboard?.writeText(clean); } catch { /* ignore */ } } },
  ];
  return (
    <ActionMenu
      items={items}
      align="left"
      menuMinWidth={200}
      triggerTitle={title || `Call ${display}`}
      triggerClassName=""
      trigger={<span style={{ color: BRAND.blue, ...style }}>{display}</span>}
      triggerProps={{ style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}
    />
  );
}
