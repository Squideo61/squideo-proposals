// React's rules of hooks, checked across the whole front end (and the Chrome
// extension) on every test run — see eslint.config.js for why this one rule.
// The render tests cover particular pages; this covers every file, including
// ones written after them.
import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (file) => relative(root, file).split(sep).join('/');

const eslint = new ESLint({
  cwd: root,
  // Re-check only files whose contents changed since the last run. Findings
  // are cached with the file, so a file with a problem keeps failing.
  cache: true,
  cacheLocation: resolve(root, 'node_modules/.cache/.eslintcache'),
  cacheStrategy: 'content',
});

let results;

beforeAll(async () => {
  results = await eslint.lintFiles(['src', 'extension/src']);
}, 180_000);

describe('the rules of hooks', () => {
  it('hold in every front-end file', () => {
    const problems = results.flatMap((r) => r.messages
      .filter((m) => m.severity === 2)
      .map((m) => `${rel(r.filePath)}:${m.line}:${m.column}  ${m.message}`));
    expect(problems, 'run `npm run lint` to see these in full').toEqual([]);
  });

  // A check that quietly looks at nothing passes forever. These pin that it
  // reaches every part of the app and that the rule is really switched on.
  it('are checked in the CRM, portal, public pages and extension', () => {
    expect(results.map((r) => rel(r.filePath))).toEqual(expect.arrayContaining([
      'src/App.jsx',
      'src/components/ClientView.jsx',
      'src/components/crm/DealDetailView.jsx',
      'src/portal/PortalApp.jsx',
      'src/quote.jsx',
      'extension/src/popup.jsx',
    ]));
  });

  it('flag a hook below an early return', async () => {
    const [probe] = await eslint.lintText([
      "import { useEffect } from 'react';",
      'export function Page({ data }) {',
      '  if (!data) return null;',
      '  useEffect(() => {});',
      '  return null;',
      '}',
    ].join('\n'), { filePath: resolve(root, 'src/components/HookProbe.jsx') });
    expect(probe.messages.map((m) => m.ruleId)).toContain('react-hooks/rules-of-hooks');
  });
});
