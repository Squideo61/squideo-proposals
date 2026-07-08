import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { BRAND } from '../../theme.js';

// Fixed bottom navigation for phones — the native-app pattern that replaces the
// old crammed top-bar icon row. Rendered only on mobile (the caller gates on
// useIsMobile). `tabs` is an ordered list of up to ~5 destinations:
//   { key, label, icon, onClick, views?, badge? }
// A tab reads as active when the current `view` is in its `views` list. The
// final "More" tab opens the full nav drawer rather than routing.
//
// While mounted it tags <body> with `has-mobile-tabbar` so styles.css can add
// bottom padding, keeping fixed-bar content clear of each page's last rows.
export function MobileTabBar({ tabs, view }) {
  useEffect(() => {
    document.body.classList.add('has-mobile-tabbar');
    return () => document.body.classList.remove('has-mobile-tabbar');
  }, []);

  // Portalled to <body> so no transformed/overflow ancestor can become its
  // containing block and let it drift up the page.
  //
  // NB: we deliberately do NOT put a `transform` on this fixed element. On iOS
  // WebKit a transform (even `translateZ(0)`) turns a position:fixed element
  // into its own containing block and makes it track the *document* rather than
  // the viewport during momentum scroll — which is exactly the "bar slides up
  // into the middle of the page while scrolling" bug. Plain position:fixed pins
  // it to the viewport floor on modern iOS without any layer-promotion hack.
  const bar = (
    <nav
      aria-label="Primary"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1000,
        display: 'flex', background: 'white', borderTop: '1px solid ' + BRAND.border,
        boxShadow: '0 -1px 8px rgba(15,42,61,0.06)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = Array.isArray(t.views) && t.views.includes(view);
        return (
          <button
            key={t.key}
            type="button"
            onClick={t.onClick}
            aria-current={active ? 'page' : undefined}
            style={{
              flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 3,
              padding: '8px 2px 6px', minHeight: 54, border: 'none', background: 'transparent',
              cursor: 'pointer', color: active ? BRAND.blue : BRAND.muted,
            }}
          >
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Icon size={22} strokeWidth={active ? 2.4 : 2} />
              {t.badge > 0 && (
                <span style={{
                  position: 'absolute', top: -5, right: -9, minWidth: 16, height: 16, padding: '0 4px',
                  borderRadius: 999, background: '#FB923C', color: 'white', fontSize: 9.5, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid white',
                }}>{t.badge > 99 ? '99+' : t.badge}</span>
              )}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: active ? 700 : 500, lineHeight: 1 }}>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );

  return createPortal(bar, document.body);
}
