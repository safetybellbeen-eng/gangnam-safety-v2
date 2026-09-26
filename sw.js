// sw.js — STEP16. PWA 캐시 전략 + 업데이트 흐름.
// 이 앱은 지도(Kakao)/Supabase를 쓰는 온라인 업무 앱이다. 완전한 offline-first로 만들지 않는다.
// - 같은 origin의 정적 asset(HTML/CSS/JS/manifest/icon)만 다룬다.
// - Kakao/Supabase 등 외부 origin 요청, 그리고 Auth/RPC/REST 같은 동적 데이터는
//   이 파일이 절대 가로채거나 Cache Storage에 저장하지 않는다(같은 origin이 아니므로
//   아래 fetch 핸들러의 origin 검사에서 자동으로 제외된다).
//
// 캐시 이름/버전: 새 버전을 배포할 때는 아래 CACHE_VERSION 문자열만 올리면 된다.
// activate 시 이 앱이 만든(CACHE_PREFIX로 시작하는) 캐시 중 현재 버전이 아닌 것만 정리하고,
// 다른 origin/다른 앱의 캐시는 건드리지 않는다(Cache Storage 자체가 origin별로 격리되어 있고,
// 여기서도 이름 prefix로 한 번 더 스스로 범위를 제한한다).
const CACHE_PREFIX = 'gnmap-v2-shell-';
const CACHE_VERSION = 'v5';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// install 시 미리 캐시하는 "앱 셸"은 자주 바뀌지 않는 최소 정적 파일만 둔다(HTML/manifest/CSS/icon).
// js/*.js는 개수가 많고 앞으로도 추가/삭제될 수 있어, 하나라도 404가 나면 cache.addAll() 전체가
// 실패해 install 자체가 깨지는 취약한 구조를 만들지 않기 위해 여기 넣지 않는다 — 대신 아래
// fetch 핸들러의 stale-while-revalidate가 처음 요청되는 시점에 각 JS 파일을 개별적으로 캐시한다.
// 전부 sw.js 기준 상대경로라 GitHub Pages의 /gangnam-safety-v2/ 하위 경로에서도 그대로 동작한다.
const APP_SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/map.css',
  './css/mobile.css',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // addAll() 대신 파일별로 개별 fetch+put한다 — 목록 중 하나가 없어져도(예: 파일 이름 변경)
      // 나머지 파일 캐시는 정상적으로 완료되고, install 전체가 실패하지 않는다.
      await Promise.allSettled(
        APP_SHELL_URLS.map(async (url) => {
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req);
          if (res && res.ok) await cache.put(req, res);
        })
      );
      // 새 버전을 최대한 빨리 활성 상태로 만든다. 단, 여기서는 clients.claim()까지만 하고
      // 열려 있는 탭을 강제로 새로고침하지는 않는다(무한 reload 루프 방지, STEP16 범위 밖).
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // GET만 다룬다. POST/PUT/DELETE(로그인, Supabase RPC/REST 쓰기 등)는 전혀 가로채지 않는다.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 같은 origin이 아니면(Kakao Maps SDK/API, Supabase REST/Auth/RPC/Edge Function,
  // jsdelivr CDN의 supabase-js/xlsx 등) 이 Service Worker는 아예 관여하지 않는다.
  // → 브라우저 기본 네트워크 동작 그대로, Cache Storage에도 저장하지 않는다.
  if (url.origin !== self.location.origin) return;

  // HTML navigation(주소 직접 접속/새로고침/탭 전환 등)은 network-first.
  // GitHub Pages에 새 버전을 배포한 뒤에도 오래된 index.html만 계속 보이는 상황을 막기 위함이다.
  // 네트워크 성공 시 최신 HTML을 쓰고 캐시도 갱신하며, 네트워크 실패(오프라인 등) 시에만
  // 캐시된 app shell(index.html)로 fallback한다 — 다른 정적 리소스 요청까지 index.html로
  // 돌려주는 SPA fallback은 만들지 않는다(이 프로젝트는 SPA 라우팅이 없는 Vanilla JS 구조).
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // 그 외 같은 origin의 정적 asset(css/js/manifest/icon 등)은 stale-while-revalidate.
  // 캐시가 있으면 즉시 그걸 응답하면서 동시에 네트워크로 최신본을 받아 캐시를 갱신해 두고,
  // 캐시가 없으면 네트워크 응답을 그대로 쓰면서 캐시에 저장한다.
  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const shellFallback = await caches.match('./index.html');
    if (shellFallback) return shellFallback;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      // basic 타입(같은 origin, 정상 응답)만 캐시한다 — opaque/에러 응답은 저장하지 않는다.
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // 오래된 캐시를 먼저 즉시 반환하고, 네트워크 갱신은 백그라운드에서 계속 진행한다
    // (응답을 기다리지 않음 — 실패해도 이미 cached를 반환했으므로 무시).
    networkFetch;
    return cached;
  }

  const networkResponse = await networkFetch;
  if (networkResponse) return networkResponse;

  // 캐시도 없고 네트워크도 실패한 경우(오프라인 상태에서 한 번도 못 받아본 asset)만 실패시킨다.
  throw new Error('네트워크와 캐시 모두 사용할 수 없습니다: ' + request.url);
}
