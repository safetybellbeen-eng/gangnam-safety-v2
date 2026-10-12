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
const CACHE_VERSION = 'v77'; // STEP16.22 배포(index.html/js/ui.js/css/mobile.css 변경) 후에도
// "필터가 작동 안 한다" 재발 — STEP16.22를 올리면서 이 값을 v7 그대로 두고 깜빡해, app shell
// (index.html/css/mobile.css)이 여전히 STEP16.21 버전으로 캐시된 채 최신 js/ui.js와 섞여 로드된
// 것이 원인으로 추정된다. 앞으로는 index.html/css/*.css 중 하나라도 바뀌는 배포마다 반드시 이
// 값을 올린다(STEP16.21에서 이미 한 번 겪은 것과 동일한 원인이다).
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
  './css/components.css',
  './css/desktop.css',
  './css/layout.css',
  './css/map.css',
  './css/mobile.css',
  './js/admin.js',
  './js/api.js',
  './js/app.js',
  './js/auth.js',
  './js/config.js',
  './js/excel.js',
  './js/favorites.js',
  './js/geocoding.js',
  './js/import.js',
  './js/location.js',
  './js/map.js',
  './js/mobile_tutorial.js',
  './js/nav_chooser.js',
  './js/notes.js',
  './js/shared_notes.js',
  './js/pc_address_search.js',
  './js/pc_admin.js',
  './js/pc_pages.js',
  './js/pc_tutorial.js',
  './js/pc_upload.js',
  './js/perf.js',
  './js/session_guard.js',
  './js/sites.js',
  './js/state.js',
  './js/supervision.js',
  './js/ui.js',
  './js/xlsx_loader.js',
  './vendor/supabase.min.js',
  './assets/data/gangnam-boundary.geojson',
  './assets/data/gangnam-dong-boundary.geojson',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/mobile-qr.png',
  './assets/icons/moel-ci-full.png',
  './assets/icons/moel-ci-cutout.png',
  './assets/icons/moel-ci.png',
  './assets/images/login-hero.webp',
  './assets/images/splash.webp',
  './assets/images/desktop-auth-bg.webp',
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
  // 외부 CDN 등) 이 Service Worker는 아예 관여하지 않는다.
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

  // 속도(2026-10): 예전에는 JS/CSS를 매 요청마다 서버에 먼저 물어봐(network-first) 파일 160여 개가 줄을
  // 서서 재방문도 느렸다. 이제 같은 origin 정적 파일은 "버전 고정 캐시 우선"으로 처리한다.
  //  - install 때 모든 JS/CSS/이미지를 새 버전 캐시에 한 번에 받아 두고(위 APP_SHELL_URLS),
  //    CACHE_VERSION이 바뀌면 옛 캐시는 통째로 지워진다 → 옛 파일과 새 파일이 섞이지 않는다.
  //  - 배포 때마다 sw.js의 CACHE_VERSION과 js/build_check.js의 B를 반드시 같이 올린다(기존 규칙 그대로).
  //  - index.html / build_check.js / sw.js / manifest.json 은 항상 network-first(가볍고, 새 버전 감지용).
  if (/\/(build_check\.js|sw\.js|manifest\.json|index\.html)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request, request.mode === 'navigate' ? undefined : { cache: 'no-cache' });
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

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  // 캐시에 없는 파일(예: 처음 쓰는 xlsx 라이브러리)은 네트워크로 받아 이 버전 캐시에 저장한다.
  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') cache.put(request, response.clone());
  return response;
}
