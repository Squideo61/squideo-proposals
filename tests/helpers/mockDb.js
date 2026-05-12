// Offline stand-in for @neondatabase/serverless's tagged-template `sql`.
//
// Test files mock api/_lib/db.js so its default export resolves to `sqlMock`.
// Each test then installs a handler via setSqlHandler (full control) or
// setSqlSequence (positional queue). All queries are recorded on `calls` so
// tests can assert which statements ran and with what parameters.

let handler = null;
const calls = [];

function flattenStrings(strings) {
  // Tagged templates pass a TemplateStringsArray; .raw is what the developer
  // typed. Joining with '?' approximates a parameterised SQL string so test
  // matchers can grep for unique substrings.
  if (strings && strings.raw && Array.isArray(strings.raw)) return strings.raw.join('?');
  if (Array.isArray(strings)) return strings.join('?');
  return String(strings);
}

export function sqlMock(strings, ...values) {
  if (!handler) {
    throw new Error('mockDb: no handler set — install one with setSqlHandler() or setSqlSequence()');
  }
  const text = flattenStrings(strings);
  calls.push({ text, values });
  return Promise.resolve(handler(text, values));
}

export function setSqlHandler(fn) {
  handler = fn;
}

export function setSqlSequence(responses) {
  let i = 0;
  handler = (text) => {
    if (i >= responses.length) {
      throw new Error(`mockDb: response queue exhausted at call ${i + 1} (${text.slice(0, 80)}…)`);
    }
    const r = responses[i++];
    return typeof r === 'function' ? r() : r;
  };
}

export function resetSqlMock() {
  handler = null;
  calls.length = 0;
}

export function getSqlCalls() {
  return calls;
}

export default sqlMock;
