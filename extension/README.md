# Squideo CRM — Chrome Extension

Sidebar, deal chips, and compose helpers for Gmail. Talks to the existing
[squideo-proposals API](https://app.squideo.com) over an
opaque extension token issued via `/extension-auth`.

## Dev setup

```bash
cd extension
npm install
npm run build
```

`npm run build` writes the unpacked extension to `extension/dist/`.

## Side-load for development

1. Visit `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Pick the `extension/dist/` folder.
5. The Squideo icon appears in the toolbar — click it, then **Connect to
   Squideo**. Sign in to the web app in the popup that opens, and the
   extension stores its long-lived token in `chrome.storage.local`.
6. Open Gmail (`https://mail.google.com`). Open any thread — the Squideo
   sidebar appears in the right rail.

## Iterating

Run `npm run watch` to rebuild on every save. Chrome reloads the extension
automatically when files in `dist/` change, but you may need to refresh the
Gmail tab to pick up content-script changes.

## File layout

```
extension/
  manifest.json          # MV3 manifest, content-script targets mail.google.com
  build.js               # builds three independent bundles: content, background, popup
  public/
    popup.html           # popup HTML shell (toolbar icon)
    icon-{16,48,128}.png # placeholder icons — replace before Web Store submission
  src/
    background.js        # service worker: auth + API proxy
    content/index.jsx    # injected into Gmail (InboxSDK loader)
    popup.jsx            # React popup with Connect / Disconnect
    lib/api.js           # thin wrapper around chrome.runtime.sendMessage
```

## Distribution

For private team rollout via the Chrome Web Store:

1. Build with `npm run build`.
2. Zip the contents of `dist/` (not the folder itself — its **contents**).
3. Upload at https://chrome.google.com/webstore/devconsole/.
4. Set **Visibility: Private** and whitelist your Workspace domain.

See `DEPLOYMENT-GUIDE.md` in the repo root for the full submission walkthrough.
