/* EasyCapture service worker — v22
   Strategy: network-first for app files (updates deploy immediately, cache is offline fallback);
   cache-first for CDN libraries and map tiles. */
const CACHE = 'easycapture-v1.1.0';
const TILE_CACHE = 'easycapture-tiles-v1';
const TILE_LIMIT = 1500;
const CORE = [
  './',
  './index.html',
  './css/app.css?v=1.1.0',
  './js/version.js?v=1.1.0',
  './js/safety.js?v=1.1.0',
  './js/icons.js?v=1.1.0',
  './js/db.js?v=1.1.0',
  './js/geo.js?v=1.1.0',
  './js/export.js?v=1.1.0',
  './js/app.js?v=1.1.0',
  './manifest.webmanifest',
  './icons/apple-touch-icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];
const LIBS = [
  './vendor/leaflet.css', './vendor/leaflet.js', './vendor/proj4.js',
  './vendor/jszip.min.js', './vendor/xlsx.full.min.js', './vendor/shp.js',
  './vendor/togeojson.umd.js', './vendor/georaster.browser.bundle.min.js',
  './vendor/georaster-layer-for-leaflet.min.js', './vendor/turf.min.js',
];

async function trimTileCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - TILE_LIMIT;
  if (excess > 0) await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // The local application shell is mandatory. If any core asset is missing,
      // installation fails instead of claiming the app is ready for offline use.
      .then((c) => c.addAll(CORE.concat(LIBS)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
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
      caches.open(TILE_CACHE).then((c) =>
        fetch(req).then((res) => {
          if (res.ok || res.type === 'opaque') c.put(req, res.clone()).then(() => trimTileCache(c));
          return res;
        }).catch(() => c.match(req))
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
