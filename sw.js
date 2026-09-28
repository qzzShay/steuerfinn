// Service Worker: macht die App offline nutzbar.
// Online wird immer frisch geladen; VERSION nur hochzählen, wenn SHELL-Dateien dazukommen/wegfallen.
const VERSION = 'sf-v2';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'scanner.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
// Fremde Dateien, die sich nie ändern (Schriften, Texterkennung): einmal laden, dann aus dem Cache
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'tessdata.projectnaptha.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'sf-static').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (STATIC_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open('sf-static').then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // Eigene Dateien: online immer frisch laden (Updates kommen sofort), offline aus dem Cache
  e.respondWith(
    caches.open(VERSION).then(async (c) => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch {
        return (await c.match(req, { ignoreSearch: true })) || c.match('index.html');
      }
    })
  );
});
