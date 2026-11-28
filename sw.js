'use strict';

const CACHE_NAME = 'accounting-pwa-v16';
const CORE_ASSETS = [
  './index.html',
  './assets/favicon.ico?v=20260521',
  './assets/css/app.css?v=75',
  './assets/js/ledger-core.js?v=139',
  './assets/js/app.js?v=141',
  './manifest.webmanifest?v=20261122-2',
  './assets/vendor/xlsx.min.js',
  './assets/icons/icon-192.png?v=20261122',
  './assets/icons/icon-512.png?v=20261122'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('accounting-pwa-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 页面优先联网获取新版本，断网时回退到已缓存的应用外壳。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 带版本号的静态资源优先读缓存，未命中时联网并写入缓存。
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
