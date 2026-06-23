import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// Register the push service worker (public/sw.js) at startup so the app is
// installable as a PWA and — critically for iOS 16.4+, which only delivers Web
// Push to a home-screen-installed PWA — the SW is already controlling the page
// before the user opts into notifications. pushSubscribe.js reuses this same
// registration; registering /sw.js is idempotent per scope so there's no clash.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
