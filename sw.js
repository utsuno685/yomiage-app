// Service Worker：アプリ本体とCDNライブラリをキャッシュしてオフライン起動に対応
const CACHE = 'yomiage-v2';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/extract.js',
  './js/tts.js',
  './js/player.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API呼び出しはキャッシュしない
  if (url.hostname.includes('googleapis.com')) return;
  if (e.request.method !== 'GET') return;

  if (url.origin === location.origin) {
    // アプリ本体：ネットワーク優先（更新を即反映）。オフライン時はキャッシュで起動
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    // CDNライブラリ（バージョン固定URL）：キャッシュ優先
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }))
    );
  }
});
