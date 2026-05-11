// Tiny wrapper around chrome.runtime.sendMessage. Content scripts can't talk
// to our API directly because of CORS — the background service worker holds
// the token and proxies fetches. All API helpers in the rest of the codebase
// should go through this.

function send(message) {
  return new Promise((resolve, reject) => {
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
