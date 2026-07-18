const CACHE_NAME = 'dchal-camera-ai-v7';
const APP_SHELL = [
  './',
  './index.html',
  './camera-verification.css',
  './camera-verification.js',
  './manifest.webmanifest',
  './app-icon-192.png',
  './app-icon-512.png',
  './character-level-3.webp'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if(requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if(response.ok){
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
  );
});

self.addEventListener('push', event => {
  let payload = {};
  try{
    payload = event.data?.json() || {};
  }catch{
    payload = { body:event.data?.text() };
  }

  const verificationId = payload.verification_id || payload.verificationId || '';
  const targetUrl = verificationId
    ? new URL(`?verification=${encodeURIComponent(verificationId)}`, self.registration.scope).href
    : self.registration.scope;

  event.waitUntil(
    self.registration.showNotification(payload.title || 'D-CHAL 인증 시간!', {
      body:payload.body || '지금부터 10분 안에 사진을 찍어주세요.',
      icon:'./app-icon-192.png',
      badge:'./app-icon-192.png',
      tag:verificationId ? `dchal-${verificationId}` : 'dchal-verification',
      renotify:true,
      requireInteraction:true,
      vibrate:[250, 120, 250, 120, 400],
      data:{ url:targetUrl, verification_id:verificationId },
      actions:[
        { action:'open-camera', title:'지금 인증하기' }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(async clientList => {
      for(const client of clientList){
        if('navigate' in client){
          await client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(targetUrl) : undefined;
    })
  );
});
