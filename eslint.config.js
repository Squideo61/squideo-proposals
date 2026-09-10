// One rule, on purpose: React's rules of hooks.
//
// A hook below an early return (`if (!data) return <Loading />`) runs on some
// renders and not others, and React throws the moment the count changes —
// "Something went wrong" instead of the page. It only shows when data arrives
// a beat late, so it survives any amount of clicking around in a preview:
// that's how client proposal links broke for three days (f35ef2a), and how the
// deal page and builder carried the same fault for months (a0feef7). This
// checks the code itself, whatever the timing.
//
// ESLint's wider rule sets are mostly style preferences and would flag plenty
// of working code, so they stay off. tests/rulesOfHooks.test.js runs this with
// the test suite; `npm run lint` runs it on its own.
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  {
    files: ['src/**/*.{js,jsx}', 'extension/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
    // The source carries a hundred-odd `eslint-disable … exhaustive-deps` notes
    // for a rule that isn't on here, so they'd all be reported as unused.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
];
