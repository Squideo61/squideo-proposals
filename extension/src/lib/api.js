// Tiny wrapper around chrome.runtime.sendMessage. Content scripts can't talk
// to our API directly because of CORS — the background service worker holds
// the token and proxies fetches. All API helpers in the rest of the codebase
// should go through this.

// Detect content scripts left behind after the extension was reloaded/updated.
// chrome.runtime APIs throw "Extension context invalidated" in that state and
// will keep throwing forever for this tab — callers should bail out of any
// polling instead of spamming the error.
export function isExtensionContextInvalidated(err) {
  const msg = (err && err.message) || '';
  return /Extension context invalidated|Extension context was invalidated/i.test(msg);
}

function send(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      // Some Chrome versions throw synchronously once the extension context
      // is gone (rather than surfacing it via lastError). Normalise so callers
      // see the same shape either way.
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export const auth = {
  status: () => send({ type: 'AUTH_STATUS' }),
  start:  () => send({ type: 'AUTH_START' }),
  clear:  () => send({ type: 'AUTH_CLEAR' }),
};

export const api = {
  get(path) {
    return send({ type: 'API', path, init: { method: 'GET' } });
  },
  post(path, body) {
    return send({ type: 'API', path, init: { method: 'POST', body: JSON.stringify(body || {}) } });
  },
  patch(path, body) {
    return send({ type: 'API', path, init: { method: 'PATCH', body: JSON.stringify(body || {}) } });
  },
  delete(path) {
    return send({ type: 'API', path, init: { method: 'DELETE' } });
  },
};
