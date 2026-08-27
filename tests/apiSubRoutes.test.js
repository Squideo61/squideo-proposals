// Vercel's generated route table sends exactly ONE path segment into a catch-all
// API function: /api/proposals/:id reaches api/proposals/[...path].js, but
// /api/proposals/:id/duplicate matches nothing and 404s before any of our code
// runs. That's why /api/crm has its :id/:action rewrites — and why a sub-route
// added without one fails in production while working in every local test.
//
// So: every sub-action the handler knows about needs a rewrite carrying the
// second segment into ?_action=, and the handler needs to read it back.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const proposalsHandler = readFileSync(resolve(root, 'api/proposals/[...path].js'), 'utf8');

const rewriteFor = (source) => vercel.rewrites.find((r) => r.source === source);

describe('proposal sub-routes reach the function at all', () => {
  it('rewrites the second path segment into a query param', () => {
    const rule = rewriteFor('/api/proposals/:id/:action');
    expect(rule).toBeTruthy();
    expect(rule.destination).toBe('/api/proposals/:id?_action=:action');
  });

  it('reads the rewritten action back in the handler', () => {
    // Without this fallback the rewrite lands on the plain single-proposal read
    // and every sub-route quietly returns the proposal instead.
    expect(proposalsHandler).toMatch(/_action/);
    expect(proposalsHandler).toMatch(/segs\[1\]\s*\|\|\s*query\.get\('_action'\)/);
  });

  it('covers every sub-action the handler branches on', () => {
    const subs = [...proposalsHandler.matchAll(/sub === '([a-z-]+)'/g)].map((m) => m[1]);
    expect(subs).toContain('duplicate');
    expect(subs).toContain('voiceover-sample');
    // One rewrite serves them all — the point is that it exists for the shape.
    expect(rewriteFor('/api/proposals/:id/:action')).toBeTruthy();
  });
});

describe('the CRM rewrites this pattern was copied from', () => {
  it('still carries id, action and subaction', () => {
    expect(rewriteFor('/api/crm/:resource/:id')).toBeTruthy();
    expect(rewriteFor('/api/crm/:resource/:id/:action')).toBeTruthy();
    expect(rewriteFor('/api/crm/:resource/:id/:action/:subaction')).toBeTruthy();
  });
});
