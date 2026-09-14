// STEP 1 스텁. 캐시 전략은 STEP 16(PWA/cache)에서 구현한다.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', () => {
  self.clients.claim();
});
