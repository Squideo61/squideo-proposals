// Renders real components in a test file that runs under
// `// @vitest-environment jsdom`, with the test deciding the order responses
// come back in — which is what the late-loading tests are about: a view that
// mounts before its data, then gets it.
import { vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Rendering whole pages is slow in jsdom — a file's first render takes a few
// seconds on its own, more with the rest of the suite running alongside — so
// these files get more than the default five seconds a test.
vi.setConfig({ testTimeout: 30_000 });

export const h = React.createElement;

// Enough of a fetch Response for src/api.js and the components' own fetches.
export const reply = (status, body) => Promise.resolve({
  status,
  ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body),
});

// A response the test holds back until it calls release().
export function held() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { gate, release: () => release() };
}

// Let every pending request chain, and the renders it triggers, finish.
export const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

// A fresh root, with console.error captured: React reports a caught render
// error through it, so a failing test can say what React objected to.
export function mountRoot() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const consoleErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  });
  return {
    container,
    render: (element) => act(async () => { root.render(element); }),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
    // The app's ErrorBoundary fallback ("Something went wrong"), if it caught one.
    crashText: () => container.querySelector('[role="alert"]')?.textContent ?? null,
    hookErrors: () => consoleErrors.filter((m) => /Rendered (more|fewer) hooks|change in the order of Hooks/.test(m)),
  };
}
