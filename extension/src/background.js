// Service worker. Two jobs:
//   1. Run the chrome.identity OAuth-like handshake against our /extension-auth
//      page and store the resulting extension token in chrome.storage.local.
//   2. Forward authenticated API requests from the content script and popup,
//      so neither has to worry about CORS or sticking the bearer header in.
//
// Manifest V3 service workers can be killed and restarted at any time, so we
// keep all persistent state in chrome.storage (not in module variables).

const API_BASE = 'https://squideo-proposals-tu96.vercel.app';
const TOKEN_KEY = 'squideoExtensionToken';
const TOKEN_EXPIRES_KEY = 'squideoExtensionTokenExpiresAt';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Message handlers all return a promise that resolves the response. We
  // return `true` from the listener so Chrome keeps the channel open while
  // we await — required for any async message handler.
  switch (msg?.type) {
    case 'AUTH_START':
      startAuth().then(sendResponse).catch(err => sendResponse({ error: err.message || String(err) }));
      return true;
    case 'AUTH_STATUS':
      getAuthStatus().then(sendResponse).catch(err => sendResponse({ error: err.message || String(err) }));
      return true;
    case 'AUTH_CLEAR':
      clearAuth().then(sendResponse).catch(err => sendResponse({ error: err.message || String(err) }));
      return true;
    case 'API':
      apiCall(msg.path, msg.init).then(sendResponse).catch(err => sendResponse({ error: err.message || String(err) }));
      return true;
    default:
      sendResponse({ error: 'Unknown message type: ' + msg?.type });
      return false;
  }
});

async function startAuth() {
  // chrome.identity.launchWebAuthFlow opens our /extension-auth page in a
  // browser window, waits for the page to redirect to chrome.identity's
  // callback URL, and hands us back the final URL with the token fragment.
  const callbackUrl = chrome.identity.getRedirectURL('squideo');
  const authUrl = `${API_BASE}/extension-auth?return=${encodeURIComponent(callbackUrl)}`;
  const resultUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message || 'Cancelled'));
        } else {
          resolve(responseUrl);
        }
      },
    );
  });

  // Token comes back in the URL fragment: ...#token=ext_xxx&expiresAt=ISO
  const fragment = (resultUrl.split('#')[1] || '').replace(/^\?/, '');
  const params = new URLSearchParams(fragment);
  const token = params.get('token');
  const expiresAt = params.get('expiresAt') || null;
  if (!token) throw new Error('No token in callback URL');

  await chrome.storage.local.set({ [TOKEN_KEY]: token, [TOKEN_EXPIRES_KEY]: expiresAt });
  return { ok: true, expiresAt };
}

async function getAuthStatus() {
  const stored = await chrome.storage.local.get([TOKEN_KEY, TOKEN_EXPIRES_KEY]);
  const token = stored[TOKEN_KEY] || null;
  const expiresAt = stored[TOKEN_EXPIRES_KEY] || null;
  const connected = !!token && (!expiresAt || new Date(expiresAt).getTime() > Date.now());
  return { connected, expiresAt };
}

async function clearAuth() {
  await chrome.storage.local.remove([TOKEN_KEY, TOKEN_EXPIRES_KEY]);
  return { ok: true };
}

async function apiCall(path, init = {}) {
  const stored = await chrome.storage.local.get([TOKEN_KEY]);
  const token = stored[TOKEN_KEY];
  if (!token) throw new Error('Not connected');

  const headers = Object.assign({}, init.headers || {});
  headers['Authorization'] = 'Bearer ' + token;
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(API_BASE + path, {
    method: init.method || 'GET',
    headers,
    body: init.body,
  });

  // 401 from the server means our token is stale or revoked — purge it so
  // the next call to AUTH_STATUS shows disconnected and the UI re-prompts.
  if (res.status === 401) {
    await chrome.storage.local.remove([TOKEN_KEY, TOKEN_EXPIRES_KEY]);
    throw new Error('Session expired — sign in again');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
