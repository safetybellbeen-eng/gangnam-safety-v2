// 자동테스트 공용 도구: 정적 서버 + 가짜 카카오 SDK + Supabase 응답 모킹.
// 실제 서버(Supabase/Kakao)에는 접속하지 않으며 사용자 데이터에 영향이 없다.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.geojson': 'application/json', '.webmanifest': 'application/json' };

export function startServer(port = 8931) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}
export const BASE = 'http://localhost:8931';

export function FAKE_KAKAO_SDK() {
  function LatLng(lat, lng) { this.lat = () => lat; this.lng = () => lng; this.getLat = () => lat; this.getLng = () => lng; }
  function Map() { this.setBounds = (b) => { window.__setBoundsPts = b._points.map(p=>[p.lat(),p.lng()]); };  this.setCenter = () => {}; this.getCenter = () => new LatLng(37.5, 127.03); this.setLevel = () => {}; this.getLevel = () => 6; this.panTo = () => {}; this.relayout = () => {}; this.getProjection = () => ({ pointFromCoords: () => ({ x: 0, y: 0 }), coordsFromPoint: () => new LatLng(0, 0) }); }
  window.__markerCount = 0; window.__calls=[];
  window.__hqMarkerCount = 0;
  function Marker(opts) {
    window.__markerCount++; (window.__mk = window.__mk || []).push(this); this._img = opts && opts.image;
    this.setMap = (m) => { this._onMap = !!m; };
    this.setImage = (i) => { this._img = i; }; this.getPosition = () => new LatLng(37.5,127.03); this.setPosition = () => {}; this.setZIndex = () => {};
  }
  function CustomOverlay(opts) {
    if (opts && opts.content && opts.content.className === 'hq-marker-label') window.__hqMarkerCount++;
    this.setMap = () => {}; this.setPosition = () => {}; this.setContent = () => {}; this.setZIndex = () => {};
  }
  window.kakao = { maps: { LatLng, LatLngBounds: function () { this._points = []; this.extend = (p) => { this._points.push(p); window.__lastBounds = this; }; }, Size: function (w, h) { this.w = w; this.h = h; }, Point: function (x, y) { this.x = x; this.y = y; }, MarkerImage: function (src, size) { this.size = size; }, Marker, Circle: function () { this.setMap = () => {}; this.setPosition = () => {}; }, Polygon: function () { this.setMap = () => {}; this.setPath = () => {}; }, CustomOverlay, MarkerClusterer: function () { this.addMarkers = () => {}; this.clear = () => {}; this.addMarker = () => {}; }, Map, event: { addListener: () => {}, trigger: () => {} }, load: (cb) => cb(), services: { Status: { OK: 'OK' }, Geocoder: function () { this.addressSearch = (a, cb) => cb([{ x: '127.03', y: '37.5' }], 'OK'); }, Places: function () { this.keywordSearch = (q, cb) => cb([], 'ZERO_RESULT'); } } } };
}
export function FAKE_GEOLOCATION() {
  const fakeGeo = {
    getCurrentPosition: (success) => {
      success({ coords: { latitude: 37.501, longitude: 127.031 } });
    },
  };
  try {
    Object.defineProperty(navigator, 'geolocation', { value: fakeGeo, configurable: true });
  } catch (e) {
    navigator.geolocation = fakeGeo;
  }
}
export function json(body, status = 200) { return { status, contentType: 'application/json', body: JSON.stringify(body) }; }
export const FAKE_USER_ID = '11111111-1111-1111-1111-111111111111';
const FAKE_USER = { id: FAKE_USER_ID, email: 'tester@example.com', aud: 'authenticated', role: 'authenticated' };
const FAKE_SESSION = { access_token: 'fake.access.token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, refresh_token: 'fake-refresh', user: FAKE_USER };
export const SAMPLE_SITES = Array.from({length: 30}, (_, i) => ({
  id: String(i+1), company_name: `업체${i+1}`, site_name: `현장 ${i+1}`, address: `서울 강남구 테스트로 ${i+1}`,
  lat: i===4?null:37.5+i*0.001, lng: i===4?null:127+i*0.001, dong: i%2===0?'역삼동':'자곡동', amount: 1000000000*(i%5+1), status: 's', is_active: true,
  location_quality: i%3===0?'EXACT':(i%3===1?'ESTIMATED':'UNRESOLVED'), period_start: '2025-01-01', period_end: '2025-12-01', supervision_count: i, accident_report_count: 0
}));
export async function installMocks(page, role = 'admin') {
  await page.route('https://kuphyemtyamglvyjpvwh.supabase.co/**', async (route) => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
    if (path === '/auth/v1/token') return route.fulfill(json(FAKE_SESSION));
    if (path === '/auth/v1/user') return route.fulfill(json(FAKE_USER));
    if (path.startsWith('/rest/v1/gnmap_v2_profiles')) return route.fulfill(json({ id: FAKE_USER_ID, name: 'x', email: 'tester@example.com', role, status: 'approved' }));
    if (path.startsWith('/rest/v1/gnmap_v2_site_notes')) return route.fulfill(json([]));
    if (path.startsWith('/rest/v1/gnmap_v2_favorites')) return route.fulfill(json([]));
    if (path.startsWith('/rest/v1/gnmap_v2_sites')) { const range = req.headers()['range']; if (range && !range.startsWith('0-')) return route.fulfill(json([])); return route.fulfill(json(SAMPLE_SITES)); }
    if (path.startsWith('/rest/v1/rpc/')) return route.fulfill(json(null));
    if (path.startsWith('/functions/v1/')) {
      const body = req.postDataJSON ? req.postDataJSON() : JSON.parse(req.postData() || '{}');
      if (body.mode === 'reverse') return route.fulfill(json({ success: true, address: '서울 강남구 테헤란로 152' }));
      if (body.mode === 'keyword') return route.fulfill(json({ success: true, candidates: [{ placeName: '강남구청', roadAddressName: '서울 강남구 테헤란로 152', lat: 37.517, lng: 127.047 }] }));
      return route.fulfill(json({ success: true, lat: 37.5, lng: 127.03, matchedAddress: '서울 강남구 테스트로 1' }));
    }
    return route.fulfill(json([]));
  });
}

// 로그인까지 마친 페이지를 돌려준다. viewport 폭 <=768 이면 모바일 화면.
export async function openLoggedIn(browser, { width = 1400, height = 900, role = 'admin' } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security|Refused to/i.test(t)) errors.push('CSP ' + t.slice(0, 200)); });
  await page.addInitScript(FAKE_KAKAO_SDK);
  await page.addInitScript(FAKE_GEOLOCATION);
  await page.addInitScript({ content: fs.readFileSync(path.join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8') }); // CSP 우회: init script는 CSP 영향 없음
  await installMocks(page, role);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-email', { state: 'visible', timeout: 15000 });
  await page.fill('#login-email', 'tester@example.com');
  await page.fill('#login-password', 'Password123!');
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('#view-approved', { state: 'visible', timeout: 15000 });
  await page.waitForLoadState('networkidle').catch(() => {}); // 서버 응답(즐겨찾기/메모 등)이 다 도착한 뒤 테스트가 상태를 바꾸도록 한다.
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.getElementById('m-tutorial')?.remove(); document.getElementById('pc-tutorial')?.remove(); });
  await page.evaluate(async () => { window.__st = (await import('/js/state.js')).state; });
  return { page, errors };
}
export const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
