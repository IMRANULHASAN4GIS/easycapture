/* Smart Maidani service worker — v9
   Strategy: network-first for app files (updates deploy immediately, cache is offline fallback);
   cache-first for CDN libraries and map tiles. */
const CACHE = 'smartmaidani-v16';
const CORE = [
  './',
  './index.html',
  './css/app.css',
  './js/icons.js',
  './js/db.js',
  './js/geo.js',
  './js/export.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const LIBS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://unpkg.com/shpjs@4.0.4/dist/shp.js',
  'https://unpkg.com/@tmcw/togeojson@5.8.1/dist/togeojson.umd.js',
  'https://unpkg.com/georaster@1.6.0/dist/georaster.browser.bundle.min.js',
  'https://unpkg.com/georaster-layer-for-leaflet@3.10.0/dist/georaster-layer-for-leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled([...CORE, ...LIBS].map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: network-first with cache fallback
  if (url.hostname.includes('tile.openstreetmap.org') || url.hostname.includes('arcgisonline.com') || url.hostname.includes('opentopomap.org')) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => c.match(req))
      )
    );
    return;
  }

  // Same-origin app files: NETWORK-FIRST so deployed updates arrive immediately; cache is the offline fallback
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // CDN libraries: cache-first (they're versioned URLs, immutable)
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); }
      return res;
    }))
  );
});
