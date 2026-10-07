// Minimal service worker: makes the site installable as an app.
// Deliberately does NOT cache anything, so a new GitHub push is always what users see
// and live sheet data is never served stale.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network as usual */ });
