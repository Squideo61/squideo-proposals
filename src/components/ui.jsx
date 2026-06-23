import React, { useEffect, useId, useState } from 'react';
import { Check, ChevronDown, Mail, Phone, X } from 'lucide-react';
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

export function PaymentOption({ selected, onSelect, title, desc, disabled, disabledReason }) {
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
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{title}</div>
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
    gold:   { bg: '#FEF3C7', fg: '#92400E' }
  };
  const c = colors[color] || colors.green;
  return (
    <span style={{ background: c.bg, color: c.fg, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12 }}>
      {children}
    </span>
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

export function StickyCTA({ totalExVat, partnerMonthlyExVat, partnerSelected, phone, email, emailName, onSign, showVat = true }) {
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
                + {formatGBP(partnerMonthlyExVat)}{showVat && ' + VAT'}/mo
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
